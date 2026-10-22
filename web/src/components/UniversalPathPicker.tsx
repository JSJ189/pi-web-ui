/**
 * UniversalPathPicker.tsx — 全项目通用的工作区与目录路径选择组件。
 *
 * 整合：
 * 1. 路径显示与直接编辑；
 * 2. 常用子目录推荐与最近项目 (projects) 下拉菜单；
 * 3. 一键调起系统的 ProjectPicker 目录浏览器弹窗。
 */
import { useState, useRef, useEffect } from "react";
import type { ProjectSummary } from "../types";
import { FiFolder, FiFolderPlus, FiChevronDown, FiClock } from "react-icons/fi";

export interface UniversalPathPickerProps {
	cwd: string;
	onSelectCwd: (cwd: string) => void;
	onOpenProjectPicker: () => void;
	projects?: ProjectSummary[];
	workspaceRoots?: string[];
	className?: string;
	placeholder?: string;
}

export function UniversalPathPicker({
	cwd,
	onSelectCwd,
	onOpenProjectPicker,
	projects = [],
	workspaceRoots = [],
	className = "",
	placeholder = "如 . 或 web 或绝对路径",
}: UniversalPathPickerProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	// 点击外部自动关闭快捷菜单
	useEffect(() => {
		const handleOutside = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		if (menuOpen) {
			window.addEventListener("mousedown", handleOutside);
			return () => window.removeEventListener("mousedown", handleOutside);
		}
	}, [menuOpen]);

	// 推荐常用子目录
	const commonDirs = [
		{ label: ". (当前项目根目录)", value: "." },
		{ label: "web (前端目录)", value: "web" },
		{ label: "server (后端服务)", value: "server" },
		{ label: "tests (测试套件)", value: "tests" },
		{ label: "src (源码目录)", value: "src" },
		{ label: "docs (文档目录)", value: "docs" },
	];

	return (
		<div className={`universal-path-picker-root ${className}`} ref={wrapRef}>
			<div className="universal-path-input-group">
				<FiFolder className="universal-path-icon" />
				<input
					type="text"
					className="universal-path-input"
					value={cwd}
					onChange={(e) => onSelectCwd(e.target.value)}
					placeholder={placeholder}
					title={`工作目录: ${cwd || "."}`}
				/>
				<button
					type="button"
					className="universal-path-dropdown-toggle"
					onClick={() => setMenuOpen(!menuOpen)}
					title="选择推荐子目录或最近项目"
				>
					<FiChevronDown />
				</button>
			</div>

			<button
				type="button"
				className="universal-path-browse-btn"
				onClick={onOpenProjectPicker}
				title="打开项目目录树浏览器点选本地文件夹"
			>
				<FiFolderPlus /> 浏览...
			</button>

			{menuOpen && (
				<div
					className="universal-path-menu"
					onPointerDown={(e) => e.stopPropagation()}
					onMouseDown={(e) => e.stopPropagation()}
					onWheel={(e) => e.stopPropagation()}
				>
					{workspaceRoots.length > 0 && (
						<>
							<div className="universal-path-menu-header">工作区根目录</div>
							{workspaceRoots.map((root) => (
								<button
									key={root}
									type="button"
									className="universal-path-menu-item"
									onClick={() => {
										onSelectCwd(root);
										setMenuOpen(false);
									}}
								>
									<span className="path-label">{root}</span>
								</button>
							))}
						</>
					)}

					<div className="universal-path-menu-header">推荐子目录</div>
					{commonDirs.map((d) => (
						<button
							key={d.value}
							type="button"
							className="universal-path-menu-item"
							onClick={() => {
								onSelectCwd(d.value);
								setMenuOpen(false);
							}}
						>
							<span className="path-label">{d.label}</span>
						</button>
					))}

					{projects.length > 0 && (
						<>
							<div className="universal-path-menu-header">
								<FiClock /> 最近项目
							</div>
							{projects.slice(0, 6).map((p) => {
								const folderName = p.path.split(/[/\\]/).filter(Boolean).pop() || p.path;
								return (
									<button
										key={p.path}
										type="button"
										className="universal-path-menu-item"
										onClick={() => {
											onSelectCwd(p.path);
											setMenuOpen(false);
										}}
										title={p.path}
									>
										<span className="path-title">{folderName}</span>
										<span className="path-sub">{p.path}</span>
									</button>
								);
							})}
						</>
					)}
				</div>
			)}
		</div>
	);
}
