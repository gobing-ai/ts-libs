#!/usr/bin/env bun
import { buildPackages, cleanPackages, fixDistRoots, smokeDistImports, typecheckPackages } from './lib/build';
import { bumpVersion, dropTags, publishPackages, verifyPublish } from './lib/release-commands';
import { findWorkspacePackages } from './lib/workspace';
import { assertPublishableManifest } from './lib/workspace-deps';

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

        case 'verify-publish': {
            const tag = args.find((arg) => !arg.startsWith('--'));
            if (!tag) usage('verify-publish <aggregate-tag> [--dispatch]', 2);
            const exitCode = await verifyPublish(tag, {
                dispatch: args.includes('--dispatch'),
            });
            process.exit(exitCode);
            break;
        }

        case 'fix-dist-esm-extensions': {
            await fixDistRoots(args);
            break;
        }

        case 'check-publish-manifest': {
            await assertPublishableManifest(args[0] ?? '.');
            console.log('publish manifest is clean: no unresolved workspace: ranges');
            break;
        }

        case 'build': {
            const packages = await findWorkspacePackages();
            await buildPackages(packages);
            break;
        }

        case 'clean': {
            const packages = await findWorkspacePackages();
            await cleanPackages(packages);
            break;
        }

        case 'typecheck': {
            const packages = await findWorkspacePackages();
            await typecheckPackages(packages);
            break;
        }

        case 'publish-packages': {
            await publishPackages(undefined, undefined, {}, { bootstrap: flagValue(args, '--bootstrap') });
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

function flagValue(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;

    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} requires a value`);
    return value;
}

function usage(commandUsage?: string, exitCode = 1): never {
    const prefix = 'Usage: bun scripts/builder.ts';
    if (commandUsage) {
        fail(`${prefix} ${commandUsage}`, exitCode);
    }

    fail(
        `Usage: bun scripts/builder.ts <command>

Commands:
  bump-version <version> [--push]
  drop-tags <version> [--remote]
  verify-publish <aggregate-tag> [--dispatch]
  clean
  build
  typecheck
  fix-dist-esm-extensions <dist-dir> [...dist-dir]
  check-publish-manifest [dir]
  publish-packages [--bootstrap <package>]
  smoke-dist-imports`,
        exitCode,
    );
}

function fail(message: string, exitCode = 1): never {
    console.error(message);
    process.exit(exitCode);
}
