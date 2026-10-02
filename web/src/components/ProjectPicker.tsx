import { useT } from "../i18n";
import {
	DirectoryBrowser,
	MACHINE_ROOT,
	browseQuery,
	joinProjectPath,
	isValidProjectName,
	parentOf,
} from "./DirectoryBrowser.js";

export { MACHINE_ROOT, browseQuery, joinProjectPath, isValidProjectName, parentOf };

interface ProjectPickerProps {
	open: boolean;
	currentCwd: string;
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	workspaceRoots: string[];
	onClose: () => void;
	onSelectDirectory: (path: string) => void;
	onCreateProject: (path: string) => void;
}

export function ProjectPicker({
	open,
	currentCwd,
	pathCompletions,
	workspaceRoots,
	onClose,
	onSelectDirectory,
	onCreateProject,
}: ProjectPickerProps) {
	const t = useT();
	if (!open) return null;

	return (
		<DirectoryBrowser
			currentCwd={currentCwd}
			pathCompletions={pathCompletions}
			workspaceRoots={workspaceRoots}
			onClose={onClose}
			onSelectDirectory={(p) => {
				onSelectDirectory(p);
				onClose();
			}}
			onCreateProject={onCreateProject}
			mode="project"
			className="project-picker"
			backdropClassName="project-picker-backdrop"
			role="dialog"
			ariaLabel={t("projectPickerTitle")}
		/>
	);
}
