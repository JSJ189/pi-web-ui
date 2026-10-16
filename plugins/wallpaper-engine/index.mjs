/**
 * wallpaper-engine 服务端入口 (v0.3.1) —— Steam 探测、壁纸扫描、流式媒体、收藏与外观预设服务。
 *
 * 核心职责：
 * 1. 自动探测 Steam 与 Wallpaper Engine (AppID 431960) 创意工坊安装目录；
 * 2. 解析 libraryfolders.vdf，枚举所有磁盘分区中的 Steam 库；
 * 3. 扫描各壁纸目录下的 project.json，提取元数据并构建壁纸索引库（支持 Video、Scene、Web、Image）；
 * 4. 提供 HTTP 路由 (/plugins-api/wallpaper-engine/api/*)：
 *    - /api/wallpapers: 壁纸列表、分类元数据与收藏集
 *    - /api/rescan: 清除内存缓存并强制重新全量扫描
 *    - /api/preview: 缩略图服务（静态图片缓存）
 *    - /api/media: 视频/图片壁纸流服务（原生支持 HTTP 206 Range 请求，流畅拖动与分片）
 *    - /api/pkg: Scene 壁纸专属 scene.pkg 二进制流服务
 *    - /api/project: 读取特定壁纸的原始 project.json 配置
 *    - /api/web: 网页壁纸（Web Wallpaper）静态资源沙箱服务（防目录遍历）
 *    - /api/favorite: 收藏/取消收藏壁纸 (POST)
 *    - /api/presets: 外观配置预设导出与导入 (GET / POST)
 *    - /api/active: 当前激活壁纸、轮播设置与外观配置 (GET / POST)
 * 5. 用户状态、收藏夹与外观配置落盘至 <dataDir>/wallpaper-engine/store.json。
 */
import { execFile } from "node:child_process";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";

/** Wallpaper Engine App ID */
const WE_APPID = "431960";

/** 扫描缓存 TTL (60 秒) */
const SCAN_CACHE_TTL_MS = 60_000;

/** 常见默认 Steam 安装路径（当注册表未配置时回退探测） */
const COMMON_STEAM_DIRS = [
	"C:\\Program Files (x86)\\Steam",
	"C:\\Program Files\\Steam",
	"D:\\Steam",
	"D:\\SteamLibrary",
	"E:\\Steam",
	"E:\\SteamLibrary",
	"F:\\SteamLibrary",
];

/** Linux / WSL / macOS 路径 */
const UNIX_STEAM_DIRS = [
	"~/.steam/steam",
	"~/.steam/root",
	"~/.local/share/Steam",
	"~/Library/Application Support/Steam",
];

const MIME_MAP = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".ogg": "audio/ogg",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".pkg": "application/octet-stream",
	".frag": "text/plain; charset=utf-8",
	".vert": "text/plain; charset=utf-8",
	".fs": "text/plain; charset=utf-8",
	".vs": "text/plain; charset=utf-8",
	".tex": "application/octet-stream",
	".mdl": "application/octet-stream",
	".bin": "application/octet-stream",
	".tga": "image/x-tga",
	".dds": "image/vnd.ms-dds",
};

export default {
	activate(host) {
		const dir = join(host.dataDir, "wallpaper-engine");
		const storeFile = join(dir, "store.json");

		// ------------------------------------------------------------ 本地状态落盘
		let store = loadStore();

		function loadStore() {
			try {
				if (existsSync(storeFile)) {
					const data = JSON.parse(readFileSync(storeFile, "utf8"));
					return {
						activeId: typeof data.activeId === "string" ? data.activeId : "",
						favorites: Array.isArray(data.favorites) ? data.favorites : [],
						settings: {
							glassBlur: Number(data.settings?.glassBlur ?? 0),
							glassOpacity: Number(data.settings?.glassOpacity ?? 40),
							wallpaperTheme: String(data.settings?.wallpaperTheme ?? "obsidian"),
							fpsLimit: String(data.settings?.fpsLimit ?? "0"),
							qualityPreset: String(data.settings?.qualityPreset ?? "performance"),
							antiAliasing: String(data.settings?.antiAliasing ?? "off"),
							interactive: Boolean(data.settings?.interactive ?? false),
							muteAudio: Boolean(data.settings?.muteAudio ?? true),
							pauseOnHidden: Boolean(data.settings?.pauseOnHidden ?? true),
							audioReactive: Boolean(data.settings?.audioReactive ?? false),
							autoRotateMinutes: String(data.settings?.autoRotateMinutes ?? "0"),
							customSteamPath: String(data.settings?.customSteamPath ?? ""),
							lightWallpaperMode: Boolean(data.settings?.lightWallpaperMode ?? false),
						},
					};
				}
			} catch (err) {
				host.log?.("warn", `读取 wallpaper-engine 配置失败，将重置默认：${err?.message || err}`);
			}
			return {
				activeId: "",
				favorites: [],
				settings: {
					glassBlur: 0,
					glassOpacity: 40,
					wallpaperTheme: "obsidian",
					fpsLimit: "0",
					qualityPreset: "high",
					antiAliasing: "off",
					interactive: false,
					muteAudio: true,
					pauseOnHidden: true,
					audioReactive: false,
					autoRotateMinutes: "0",
					customSteamPath: "",
					lightWallpaperMode: false,
				},
			};
		}

		function persistStore() {
			try {
				mkdirSync(dir, { recursive: true });
				const tmp = `${storeFile}.tmp.${process.pid}`;
				writeFileSync(tmp, JSON.stringify(store, null, "\t"), "utf8");
				renameSync(tmp, storeFile);
			} catch (err) {
				host.log?.("error", `保存 wallpaper-engine 配置失败：${err?.message || err}`);
			}
		}

		// ------------------------------------------------------------ Steam 路径与库探测
		let cachedSteamRoot = null;
		let cachedLibraries = [];
		let cachedWallpapers = null;
		let cachedWallpaperMap = new Map();
		let lastScanTime = 0;

		async function probeSteamFromRegistry() {
			if (process.platform !== "win32") return null;
			const regExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
			if (!existsSync(regExe)) return null;

			return new Promise((resolvePromise) => {
				try {
					execFile(
						regExe,
						["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
						{ encoding: "utf8", windowsHide: true, timeout: 5000 },
						(err, stdout) => {
							if (err) {
								resolvePromise(null);
								return;
							}
							const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout || "");
							if (m && m[1]) {
								resolvePromise(normalize(m[1].trim()));
							} else {
								resolvePromise(null);
							}
						},
					);
				} catch {
					resolvePromise(null);
				}
			});
		}

		async function resolveSteamRoot() {
			if (store.settings.customSteamPath && existsSync(store.settings.customSteamPath)) {
				return normalize(store.settings.customSteamPath);
			}

			if (cachedSteamRoot && existsSync(cachedSteamRoot)) {
				return cachedSteamRoot;
			}

			const fromReg = await probeSteamFromRegistry();
			if (fromReg && existsSync(fromReg)) {
				cachedSteamRoot = fromReg;
				return fromReg;
			}

			if (process.platform === "win32") {
				for (const cand of COMMON_STEAM_DIRS) {
					if (existsSync(cand)) {
						cachedSteamRoot = cand;
						return cand;
					}
				}
			}

			const home = homedir();
			for (const cand of UNIX_STEAM_DIRS) {
				const resolvedPath = cand.startsWith("~/") ? join(home, cand.slice(2)) : cand;
				if (existsSync(resolvedPath)) {
					cachedSteamRoot = resolvedPath;
					return resolvedPath;
				}
			}

			return null;
		}

		async function resolveAllSteamLibraries() {
			const steamRoot = await resolveSteamRoot();
			if (!steamRoot) return [];

			const libsMap = new Map();
			function addLib(p) {
				const norm = normalize(p);
				const key = process.platform === "win32" ? norm.toLowerCase() : norm;
				if (!libsMap.has(key)) {
					libsMap.set(key, norm);
				}
			}

			addLib(steamRoot);

			const vdfPath = join(steamRoot, "steamapps", "libraryfolders.vdf");
			if (existsSync(vdfPath)) {
				try {
					const content = readFileSync(vdfPath, "utf8");
					const matches = content.matchAll(/"path"\s+"([^"]+)"/gi);
					for (const match of matches) {
						if (match[1]) {
							const libPath = normalize(match[1].replace(/\\\\/g, "\\"));
							if (existsSync(libPath)) {
								addLib(libPath);
							}
						}
					}
				} catch (err) {
					host.log?.("warn", `解析 libraryfolders.vdf 失败：${err?.message || err}`);
				}
			}

			cachedLibraries = Array.from(libsMap.values());
			return cachedLibraries;
		}

		// ------------------------------------------------------------ 壁纸扫描与索引
		async function scanWallpapers(force = false) {
			const now = Date.now();
			if (!force && cachedWallpapers && now - lastScanTime < SCAN_CACHE_TTL_MS) {
				return cachedWallpapers;
			}

			const libraries = await resolveAllSteamLibraries();
			const list = [];
			const seenIds = new Set();

			for (const lib of libraries) {
				const workshopDir = join(lib, "steamapps", "workshop", "content", WE_APPID);
				if (existsSync(workshopDir)) {
					try {
						const entries = readdirSync(workshopDir, { withFileTypes: true });
						for (const entry of entries) {
							if (!entry.isDirectory()) continue;
							const itemDir = join(workshopDir, entry.name);
							const meta = parseWallpaperProject(itemDir, `workshop_${entry.name}`);
							if (meta && !seenIds.has(meta.id)) {
								seenIds.add(meta.id);
								list.push(meta);
							}
						}
					} catch (err) {
						host.log?.("warn", `扫描创意工坊目录 ${workshopDir} 出错：${err?.message || err}`);
					}
				}

				const defaultProjectsDir = join(lib, "steamapps", "common", "wallpaper_engine", "projects", "defaultprojects");
				if (existsSync(defaultProjectsDir)) {
					try {
						const entries = readdirSync(defaultProjectsDir, { withFileTypes: true });
						for (const entry of entries) {
							if (!entry.isDirectory()) continue;
							const itemDir = join(defaultProjectsDir, entry.name);
							const meta = parseWallpaperProject(itemDir, `default_${entry.name}`);
							if (meta && !seenIds.has(meta.id)) {
								seenIds.add(meta.id);
								list.push(meta);
							}
						}
					} catch (err) {
						host.log?.("warn", `扫描默认壁纸目录 ${defaultProjectsDir} 出错：${err?.message || err}`);
					}
				}
			}

			cachedWallpapers = list;
			cachedWallpaperMap = new Map(list.map((w) => [w.id, w]));
			lastScanTime = now;
			return list;
		}

		async function getWallpaperById(id) {
			if (!id) return null;
			if (cachedWallpaperMap.has(id)) {
				return cachedWallpaperMap.get(id);
			}
			const list = await scanWallpapers(false);
			return cachedWallpaperMap.get(id) || list.find((w) => w.id === id) || null;
		}

		function parseWallpaperProject(folderPath, id) {
			const projectJson = join(folderPath, "project.json");
			if (!existsSync(projectJson)) return null;

			try {
				const json = JSON.parse(readFileSync(projectJson, "utf8"));
				const title = json.title || basename(folderPath);
				const rawType = (json.type || "").toLowerCase();

				const rawFile = json.file || "";
				const filePath = rawFile ? join(folderPath, rawFile) : "";
				const fileExt = extname(rawFile).toLowerCase();

				const scenePkgCand = join(folderPath, "scene.pkg");
				const hasScenePkg = (rawFile.endsWith(".pkg") && existsSync(filePath)) || existsSync(scenePkgCand);
				const pkgPath = hasScenePkg ? (rawFile.endsWith(".pkg") && existsSync(filePath) ? filePath : scenePkgCand) : "";

				const sceneJsonCand = join(folderPath, "scene.json");
				const hasSceneJson =
					(rawFile.endsWith(".json") && existsSync(filePath)) || existsSync(sceneJsonCand) || rawFile.endsWith(".json");
				const isLooseScene = !hasScenePkg && (rawType === "scene" || Boolean(hasSceneJson));

				const webIndexCand = join(folderPath, "index.html");
				const hasWebIndex = (rawFile.endsWith(".html") && existsSync(filePath)) || existsSync(webIndexCand);
				const webFile = hasWebIndex ? (rawFile.endsWith(".html") ? rawFile : "index.html") : "";

				let type = "unknown";
				if (rawType === "video" || [".mp4", ".webm", ".m4v", ".mov"].includes(fileExt)) {
					type = "video";
				} else if (rawType === "scene" || hasScenePkg || hasSceneJson || [".pkg", ".json"].includes(fileExt)) {
					type = "scene";
				} else if (rawType === "web" || hasWebIndex || [".html", ".htm"].includes(fileExt)) {
					type = "web";
				} else if (rawType === "image" || [".jpg", ".jpeg", ".png", ".webp"].includes(fileExt)) {
					type = "image";
				} else if (rawType === "application") {
					type = "application";
				}

				let previewFile = json.preview || "";
				let previewPath = previewFile ? join(folderPath, previewFile) : "";
				if (!existsSync(previewPath)) {
					for (const cand of ["preview.jpg", "preview.gif", "preview.png", "preview.webp"]) {
						const p = join(folderPath, cand);
						if (existsSync(p)) {
							previewFile = cand;
							previewPath = p;
							break;
						}
					}
				}

				return {
					id,
					title,
					type,
					rawType,
					description: json.description || "",
					folder: folderPath,
					file: rawFile,
					filePath: existsSync(filePath) ? filePath : "",
					pkgPath,
					hasSceneJson: Boolean(hasSceneJson),
					isLooseScene: Boolean(isLooseScene),
					webFile,
					previewFile,
					previewPath: existsSync(previewPath) ? previewPath : "",
					tags: Array.isArray(json.tags) ? json.tags : [],
					rating: json.contentrating || "Everyone",
					properties: json.general?.properties || null,
				};
			} catch {
				return null;
			}
		}

		// ------------------------------------------------------------ HTTP 路由服务
		const offRoutes = [];

		function registerRoute(method, path, handler) {
			const off = host.route(method, path, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					host.log?.("error", `[wallpaper-engine] ${method} ${path} 抛错: ${err?.message || err}`);
					if (!res.headersSent) {
						res.status(500).json({ ok: false, error: err?.message || "Internal error" });
					}
				}
			});
			offRoutes.push(off);
		}

		// 1. GET /api/wallpapers —— 壁纸列表查询
		registerRoute("GET", "/api/wallpapers", async (_req, res) => {
			const steamRoot = await resolveSteamRoot();
			const list = await scanWallpapers(false);
			const playable = list.filter((w) => w.type !== "application");

			res.json({
				ok: true,
				steamFound: Boolean(steamRoot),
				steamPath: steamRoot || "",
				activeId: store.activeId,
				favorites: store.favorites,
				settings: store.settings,
				total: playable.length,
				wallpapers: playable.map((w) => ({
					id: w.id,
					title: w.title,
					type: w.type,
					file: w.file,
					hasVideo: w.type === "video" && Boolean(w.filePath),
					hasScene: w.type === "scene" && (Boolean(w.pkgPath) || Boolean(w.hasSceneJson) || Boolean(w.isLooseScene)),
					hasPkg: Boolean(w.pkgPath),
					isLooseScene: Boolean(w.isLooseScene),
					hasWeb: w.type === "web" && Boolean(w.webFile),
					hasImage: w.type === "image" && Boolean(w.filePath),
					hasPreview: Boolean(w.previewPath),
					isFavorite: store.favorites.includes(w.id),
					tags: w.tags,
					rating: w.rating,
					description: w.description,
				})),
			});
		});

		// 2. GET /api/rescan —— 强制重新扫描
		registerRoute("GET", "/api/rescan", async (_req, res) => {
			cachedSteamRoot = null;
			cachedWallpapers = null;
			const list = await scanWallpapers(true);
			const steamRoot = await resolveSteamRoot();
			const playable = list.filter((w) => w.type !== "application");

			res.json({
				ok: true,
				steamFound: Boolean(steamRoot),
				steamPath: steamRoot || "",
				total: playable.length,
				activeId: store.activeId,
				favorites: store.favorites,
				settings: store.settings,
				wallpapers: playable.map((w) => ({
					id: w.id,
					title: w.title,
					type: w.type,
					file: w.file,
					hasVideo: w.type === "video" && Boolean(w.filePath),
					hasScene: w.type === "scene" && (Boolean(w.pkgPath) || Boolean(w.hasSceneJson) || Boolean(w.isLooseScene)),
					hasPkg: Boolean(w.pkgPath),
					isLooseScene: Boolean(w.isLooseScene),
					hasWeb: w.type === "web" && Boolean(w.webFile),
					hasImage: w.type === "image" && Boolean(w.filePath),
					hasPreview: Boolean(w.previewPath),
					isFavorite: store.favorites.includes(w.id),
					tags: w.tags,
					rating: w.rating,
					description: w.description,
				})),
			});
		});

		// 3. GET /api/preview —— 缩略图服务
		registerRoute("GET", "/api/preview", async (req, res) => {
			const id = String(req.query?.id || "");
			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.previewPath || !existsSync(item.previewPath)) {
				res.status(404).end("Preview not found");
				return;
			}

			const ext = extname(item.previewPath).toLowerCase();
			const contentType = MIME_MAP[ext] || "application/octet-stream";

			res.setHeader("Content-Type", contentType);
			res.setHeader("Cache-Control", "public, max-age=86400");
			createReadStream(item.previewPath).pipe(res);
		});

		// 4. GET /api/media —— 壁纸流式播放 (HTTP 206 Partial Content)
		registerRoute("GET", "/api/media", async (req, res) => {
			const id = String(req.query?.id || "");
			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.filePath || !existsSync(item.filePath)) {
				res.status(404).end("Media file not found");
				return;
			}

			const stat = statSync(item.filePath);
			const fileSize = stat.size;
			const ext = extname(item.filePath).toLowerCase();
			const contentType = MIME_MAP[ext] || "application/octet-stream";

			const range = req.headers.range;
			if (range) {
				const parts = range.replace(/bytes=/, "").split("-");
				const start = parseInt(parts[0], 10);
				const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

				if (start >= fileSize || end >= fileSize) {
					res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
					return;
				}

				const chunksize = end - start + 1;
				res.writeHead(206, {
					"Content-Range": `bytes ${start}-${end}/${fileSize}`,
					"Accept-Ranges": "bytes",
					"Content-Length": chunksize,
					"Content-Type": contentType,
				});

				const stream = createReadStream(item.filePath, { start, end });
				stream.pipe(res);
			} else {
				res.writeHead(200, {
					"Content-Length": fileSize,
					"Accept-Ranges": "bytes",
					"Content-Type": contentType,
				});
				createReadStream(item.filePath).pipe(res);
			}
		});

		// 5. GET /api/pkg —— Scene 壁纸二进制 scene.pkg 数据流
		registerRoute("GET", "/api/pkg", async (req, res) => {
			const id = String(req.query?.id || "");
			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.pkgPath || !existsSync(item.pkgPath)) {
				res.status(404).end("Scene package file not found");
				return;
			}

			const stat = statSync(item.pkgPath);
			res.writeHead(200, {
				"Content-Type": "application/octet-stream",
				"Content-Length": stat.size,
				"Cache-Control": "public, max-age=86400",
			});
			createReadStream(item.pkgPath).pipe(res);
		});

		// 6. GET /api/project —— 读取原始 project.json
		registerRoute("GET", "/api/project", async (req, res) => {
			const id = String(req.query?.id || "");
			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item) {
				res.status(404).end("Wallpaper not found");
				return;
			}

			const projectJsonPath = join(item.folder, "project.json");
			if (!existsSync(projectJsonPath)) {
				res.status(404).end("project.json not found");
				return;
			}

			try {
				const json = JSON.parse(readFileSync(projectJsonPath, "utf8"));
				res.json(json);
			} catch (err) {
				res.status(500).json({ ok: false, error: err.message });
			}
		});

		// 6.5 GET /api/scene-file —— 散装 Scene 场景工程文件安全读取服务 (支持官方内置散装工程与未封包壁纸)
		registerRoute("GET", "/api/scene-file", async (req, res) => {
			const id = String(req.query?.id || "");
			const reqRelFile = String(req.query?.file || "");

			if (!id || !reqRelFile) {
				res.status(400).end("Missing wallpaper id or file");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.folder || !existsSync(item.folder)) {
				res.status(404).end("Wallpaper folder not found");
				return;
			}

			const safeRel = reqRelFile.replace(/\\/g, "/").replace(/^\/+/, "");
			const targetPath = resolve(item.folder, safeRel);
			const normalizedBase = resolve(item.folder);

			if (!targetPath.startsWith(normalizedBase) || !existsSync(targetPath)) {
				res.status(404).end("File not found in wallpaper directory");
				return;
			}

			const stat = statSync(targetPath);
			if (!stat.isFile()) {
				res.status(403).end("Cannot access directories directly");
				return;
			}

			const ext = extname(targetPath).toLowerCase();
			const contentType = MIME_MAP[ext] || "application/octet-stream";

			res.setHeader("Content-Type", contentType);
			res.setHeader("Cache-Control", "public, max-age=86400");
			createReadStream(targetPath).pipe(res);
		});

		// 7. GET /api/web —— 网页壁纸静态资源沙箱服务
		registerRoute("GET", "/api/web", async (req, res) => {
			const id = String(req.query?.id || "");
			const reqRelFile = String(req.query?.file || "index.html");

			if (!id) {
				res.status(400).end("Missing wallpaper id");
				return;
			}

			const item = await getWallpaperById(id);
			if (!item || !item.folder || !existsSync(item.folder)) {
				res.status(404).end("Wallpaper folder not found");
				return;
			}

			const safeRel = reqRelFile.replace(/\\/g, "/").replace(/^\/+/, "");
			const targetPath = resolve(item.folder, safeRel);
			const normalizedBase = resolve(item.folder);

			if (!targetPath.startsWith(normalizedBase) || !existsSync(targetPath)) {
				res.status(404).end("File not found in wallpaper directory");
				return;
			}

			const stat = statSync(targetPath);
			if (!stat.isFile()) {
				res.status(403).end("Cannot access directories directly");
				return;
			}

			const ext = extname(targetPath).toLowerCase();
			const contentType = MIME_MAP[ext] || "application/octet-stream";

			if (ext === ".html" || ext === ".htm") {
				let html = readFileSync(targetPath, "utf8");
				const weShim = `
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<style>
html, body {
	width: 100% !important;
	height: 100% !important;
	margin: 0 !important;
	padding: 0 !important;
	overflow: hidden !important;
	background: transparent !important;
}
canvas, video, img {
	image-rendering: -webkit-optimize-contrast;
	image-rendering: high-quality;
}
</style>
<script>
/* Wallpaper Engine API Shims */
window.wallpaperPropertyListener = window.wallpaperPropertyListener || {};
window.wallpaperRegisterAudioListener = window.wallpaperRegisterAudioListener || function(cb) {
	window.__weAudioCb = cb;
};
window.wallpaperRegisterMediaListener = window.wallpaperRegisterMediaListener || function() {};
</script>
`;
				if (html.includes("<head>")) {
					html = html.replace("<head>", `<head>${weShim}`);
				} else {
					html = `${weShim}${html}`;
				}

				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Length": Buffer.byteLength(html, "utf8"),
				});
				res.end(html);
				return;
			}

			res.writeHead(200, {
				"Content-Type": contentType,
				"Content-Length": stat.size,
				"Cache-Control": "public, max-age=3600",
			});
			createReadStream(targetPath).pipe(res);
		});

		// 8. POST /api/favorite —— 切换收藏状态
		registerRoute("POST", "/api/favorite", async (req, res) => {
			const id = String(req.body?.id || "");
			if (!id) {
				res.status(400).json({ ok: false, error: "Missing id" });
				return;
			}

			const idx = store.favorites.indexOf(id);
			if (idx >= 0) {
				store.favorites.splice(idx, 1);
			} else {
				store.favorites.push(id);
			}

			persistStore();

			host.broadcast({
				type: "wallpaper_favorites_updated",
				favorites: store.favorites,
			});

			res.json({
				ok: true,
				id,
				isFavorite: store.favorites.includes(id),
				favorites: store.favorites,
			});
		});

		// 9. GET /api/presets & POST /api/presets —— 预设导出与导入
		registerRoute("GET", "/api/presets", async (_req, res) => {
			res.json({
				ok: true,
				schema: "pi-wallpaper-engine-preset-v1",
				activeId: store.activeId,
				favorites: store.favorites,
				settings: store.settings,
				timestamp: Date.now(),
			});
		});

		registerRoute("POST", "/api/presets", async (req, res) => {
			const preset = req.body || {};
			if (preset.settings && typeof preset.settings === "object") {
				store.settings = {
					...store.settings,
					...preset.settings,
				};
			}
			if (typeof preset.activeId === "string") {
				store.activeId = preset.activeId;
			}
			if (Array.isArray(preset.favorites)) {
				store.favorites = preset.favorites;
			}

			persistStore();

			host.broadcast({
				type: "wallpaper_state_updated",
				activeId: store.activeId,
				settings: store.settings,
				favorites: store.favorites,
			});

			res.json({
				ok: true,
				activeId: store.activeId,
				settings: store.settings,
				favorites: store.favorites,
			});
		});

		// 10. GET /api/active —— 获取当前激活的壁纸与设置
		registerRoute("GET", "/api/active", async (_req, res) => {
			const activeItem = await getWallpaperById(store.activeId);

			res.json({
				ok: true,
				activeId: store.activeId,
				favorites: store.favorites,
				settings: store.settings,
				activeWallpaper: activeItem
					? {
							id: activeItem.id,
							title: activeItem.title,
							type: activeItem.type,
							hasVideo: activeItem.type === "video" && Boolean(activeItem.filePath),
							hasScene: activeItem.type === "scene" && Boolean(activeItem.pkgPath),
							hasWeb: activeItem.type === "web" && Boolean(activeItem.webFile),
							hasImage: activeItem.type === "image" && Boolean(activeItem.filePath),
							webFile: activeItem.webFile || "index.html",
						}
					: null,
			});
		});

		// 11. POST /api/active —— 保存激活的壁纸与设置
		registerRoute("POST", "/api/active", async (req, res) => {
			const body = req.body || {};
			if (typeof body.activeId === "string") {
				store.activeId = body.activeId;
			}
			if (Array.isArray(body.favorites)) {
				store.favorites = body.favorites;
			}
			if (body.settings && typeof body.settings === "object") {
				store.settings = {
					...store.settings,
					glassBlur: Number(body.settings.glassBlur ?? store.settings.glassBlur),
					glassOpacity: Number(body.settings.glassOpacity ?? store.settings.glassOpacity),
					wallpaperTheme: String(body.settings.wallpaperTheme ?? store.settings.wallpaperTheme),
					fpsLimit: String(body.settings.fpsLimit ?? store.settings.fpsLimit),
					qualityPreset: String(body.settings.qualityPreset ?? store.settings.qualityPreset),
					antiAliasing: String(body.settings.antiAliasing ?? store.settings.antiAliasing),
					interactive: Boolean(body.settings.interactive ?? store.settings.interactive),
					muteAudio: Boolean(body.settings.muteAudio ?? store.settings.muteAudio),
					pauseOnHidden: Boolean(body.settings.pauseOnHidden ?? store.settings.pauseOnHidden),
					audioReactive: Boolean(body.settings.audioReactive ?? store.settings.audioReactive),
					autoRotateMinutes: String(body.settings.autoRotateMinutes ?? store.settings.autoRotateMinutes),
					customSteamPath: String(body.settings.customSteamPath ?? store.settings.customSteamPath),
					lightWallpaperMode: Boolean(body.settings.lightWallpaperMode ?? store.settings.lightWallpaperMode),
				};
			}

			persistStore();

			host.broadcast({
				type: "wallpaper_state_updated",
				activeId: store.activeId,
				settings: store.settings,
				favorites: store.favorites,
			});

			res.json({
				ok: true,
				activeId: store.activeId,
				settings: store.settings,
				favorites: store.favorites,
			});
		});

		host.log?.("info", "wallpaper-engine 插件服务端 (v0.3.13) 已就绪");

		return () => {
			for (const off of offRoutes) {
				try {
					off();
				} catch {
					/* ignore */
				}
			}
			offRoutes.length = 0;
		};
	},
};
