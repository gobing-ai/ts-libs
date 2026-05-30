#!/usr/bin/env bun
import { buildPackages, fixDistRoots, smokeDistImports, typecheckPackages } from './lib/build';
import { bumpVersion, dropTags, publishPackages } from './lib/release-commands';
import { findWorkspacePackages } from './lib/workspace';

const [command, ...args] = process.argv.slice(2);

try {
    switch (command) {
        case 'bump-version':
        case 'bump-ver': {
            const version = args.find((arg) => !arg.startsWith('--'));
            if (!version) usage('bump-version <version> [--push]');
            await bumpVersion(version, { push: args.includes('--push') });
            break;
        }

        case 'drop-tags': {
            const version = args.find((arg) => !arg.startsWith('--'));
            if (!version) usage('drop-tags <version> [--remote]');
            await dropTags(version, { remote: args.includes('--remote') });
            break;
        }

        case 'fix-dist-esm-extensions': {
            await fixDistRoots(args);
            break;
        }

        case 'build': {
            const packages = await findWorkspacePackages();
            await buildPackages(packages);
            break;
        }

        case 'typecheck': {
            const packages = await findWorkspacePackages();
            await typecheckPackages(packages);
            break;
        }

        case 'publish-packages': {
            await publishPackages();
            break;
        }

        case 'smoke-dist-imports': {
            const packages = await findWorkspacePackages();
            await smokeDistImports(packages);
            break;
        }

        default:
            usage();
    }
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}

function usage(commandUsage?: string): never {
    const prefix = 'Usage: bun scripts/builder.ts';
    if (commandUsage) {
        fail(`${prefix} ${commandUsage}`);
    }

    fail(`Usage: bun scripts/builder.ts <command>

Commands:
  bump-version <version> [--push]
  drop-tags <version> [--remote]
  build
  typecheck
  fix-dist-esm-extensions <dist-dir> [...dist-dir]
  publish-packages
  smoke-dist-imports`);
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}
