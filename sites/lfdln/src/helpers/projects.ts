// lfdln-projects.service: the projects helper (docs/phase8b-plan.md).
import { runProjects } from '@panel/projects/helper/main';
import { PROFILE } from '../profile.ts';

// a project reaches lfdln-appdb and lfdln-appmaria, and nothing else on the server (docs/s1-plan.md S1d)
runProjects({ dbPorts: Object.values(PROFILE.services.studioPorts ?? {}) });
