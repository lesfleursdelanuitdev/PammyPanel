// Every module's definition (docs/module-contracts-plan.md section 1, step C1): the one place
// that names them all. The sites and the tests hand REGISTRY to the kernel (loadConfig); the
// kernel itself imports no module.
import type { Module } from '@panel/core/profile';
import type { ModuleDefinition, ModuleRegistry } from '@panel/core/module';
import mail from '@panel/mail/module';
import areas from '@panel/areas/module';
import people from '@panel/people/module';
import requests from '@panel/requests/module';
import settings from '@panel/settings/module';
import catalog from '@panel/catalog/module';
import files from '@panel/files/module';
import thumbs from '@panel/thumbs/module';
import media from '@panel/media/module';
import forms from '@panel/forms/module';
import apiKeys from '@panel/api-keys/module';
import studio from '@panel/studio/module';
import formLinks from '@panel/form-links/module';
import comments from '@panel/comments/module';
import apps from '@panel/apps/module';
import php from '@panel/php/module';
import examples from '@panel/examples/module';
import help from '@panel/help/module';
import gettingStarted from '@panel/getting-started/module';
import hosts from '@panel/hosts/module';
import services from '@panel/services/module';
import monitoring from '@panel/monitoring/module';
import projects from '@panel/projects/module';

// in MODULES' order (test/modules.test.ts checks the two agree)
export const DEFINITIONS: readonly ModuleDefinition[] = [mail, areas, people, requests, settings, catalog, files, thumbs, media, forms, apiKeys, studio, formLinks, comments, apps, php, examples, help, gettingStarted, hosts, services, monitoring, projects];

export const REGISTRY = Object.fromEntries(DEFINITIONS.map((d) => [d.name, d])) as ModuleRegistry;

// The modules each module needs on (the same edges as the packages' dependencies).
export const NEEDS = Object.fromEntries(DEFINITIONS.map((d) => [d.name, d.needs])) as Record<Module, readonly Module[]>;

// The facts each module needs from the profile: a site with the module off may leave them out.
export const FACTS: Partial<Record<Module, readonly string[]>> = Object.fromEntries(DEFINITIONS.filter((d) => d.facts.length).map((d) => [d.name, d.facts]));
