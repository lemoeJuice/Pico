import type { Project } from '../core/types.js';

export function upsertProject(projects: Project[], project: Project): Project[] {
  const index = projects.findIndex((item) => item.id === project.id);
  if (index < 0) return [project, ...projects];
  const next = [...projects];
  next[index] = project;
  return next;
}
