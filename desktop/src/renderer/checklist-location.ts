import {CHECKLIST_FILENAME} from './course-checklist';

/** Navigation context is not a storage choice. Explicit file links keep their original identity. */
export function initialChecklistLocation(_contextFolder = '', explicitPath?: string): {folder:string;name:string;path:string} {
  const path = explicitPath ?? CHECKLIST_FILENAME;
  const parts = path.split('/');
  return {folder:parts.slice(0,-1).join('/'), name:parts.at(-1)!, path};
}

/** Creating a new list must never inherit a browsed course/week folder. Existing-file saves are separate. */
export function checklistCreationLocation(folder:string, name = CHECKLIST_FILENAME): {parentPath:string;name:string} {
  if (folder) throw new Error('新清单只能保存在资料库主文件夹；旧清单仍可在原位置编辑。 / New checklists belong in the library’s main folder; existing lists can still be edited in place.');
  return {parentPath:'',name};
}
