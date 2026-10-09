// Asking the projects helper (lfdln-projects.socket), as the panel does.
import { callJsonLine } from '@panel/core/jsonline';

export const callProjects = <T>(socket: string, req: Record<string, unknown>): Promise<T> =>
  callJsonLine<T>(socket, req, 'projects helper', 21 * 60_000);
