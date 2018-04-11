"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
const core_1 = require("@angular-devkit/core");
const schematics_1 = require("@angular-devkit/schematics");
const tasks_1 = require("@angular-devkit/schematics/tasks");
const rxjs_1 = require("rxjs");
const operators_1 = require("rxjs/operators");
const semver = require("semver");
const npm_1 = require("./npm");
function _validateForwardPeerDependencies(name, infoMap, peers, logger) {
    for (const [peer, range] of Object.entries(peers)) {
        logger.debug(`Checking forward peer ${peer}...`);
        const maybePeerInfo = infoMap.get(peer);
        if (!maybePeerInfo) {
            logger.error([
                `Package ${JSON.stringify(name)} has a missing peer dependency of`,
                `${JSON.stringify(peer)} @ ${JSON.stringify(range)}.`,
            ].join(' '));
            return true;
        }
        const peerVersion = maybePeerInfo.target && maybePeerInfo.target.packageJson.version
            ? maybePeerInfo.target.packageJson.version
            : maybePeerInfo.installed.version;
        logger.debug(`  Range intersects(${range}, ${peerVersion})...`);
        if (!semver.satisfies(peerVersion, range)) {
            logger.error([
                `Package ${JSON.stringify(name)} has an incompatible peer dependency to`,
                `${JSON.stringify(peer)} (requires ${JSON.stringify(range)},`,
                `would install ${JSON.stringify(peerVersion)})`,
            ].join(' '));
            return true;
        }
    }
    return false;
}
function _validateReversePeerDependencies(name, version, infoMap, logger) {
    for (const [installed, installedInfo] of infoMap.entries()) {
        const installedLogger = logger.createChild(installed);
        installedLogger.debug(`${installed}...`);
        const peers = (installedInfo.target || installedInfo.installed).packageJson.peerDependencies;
        for (const [peer, range] of Object.entries(peers || {})) {
            if (peer != name) {
                // Only check peers to the packages we're updating. We don't care about peers
                // that are unmet but we have no effect on.
                continue;
            }
            if (!semver.satisfies(version, range)) {
                logger.error([
                    `Package ${JSON.stringify(installed)} has an incompatible peer dependency to`,
                    `${JSON.stringify(name)} (requires ${JSON.stringify(range)},`,
                    `would install ${JSON.stringify(version)}).`,
                ].join(' '));
                return true;
            }
        }
    }
    return false;
}
function _validateUpdatePackages(infoMap, force, logger) {
    logger.debug('Updating the following packages:');
    infoMap.forEach(info => {
        if (info.target) {
            logger.debug(`  ${info.name} => ${info.target.version}`);
        }
    });
    let peerErrors = false;
    infoMap.forEach(info => {
        const { name, target } = info;
        if (!target) {
            return;
        }
        const pkgLogger = logger.createChild(name);
        logger.debug(`${name}...`);
        const peers = target.packageJson.peerDependencies || {};
        peerErrors = _validateForwardPeerDependencies(name, infoMap, peers, pkgLogger) || peerErrors;
        peerErrors
            = _validateReversePeerDependencies(name, target.version, infoMap, pkgLogger)
                || peerErrors;
    });
    if (!force && peerErrors) {
        throw new schematics_1.SchematicsException(`Incompatible peer dependencies found. See above.`);
    }
}
function _performUpdate(tree, context, infoMap, logger, migrateOnly) {
    const packageJsonContent = tree.read('/package.json');
    if (!packageJsonContent) {
        throw new schematics_1.SchematicsException('Could not find a package.json. Are you in a Node project?');
    }
    let packageJson;
    try {
        packageJson = JSON.parse(packageJsonContent.toString());
    }
    catch (e) {
        throw new schematics_1.SchematicsException('package.json could not be parsed: ' + e.message);
    }
    const toInstall = [...infoMap.values()]
        .map(x => [x.name, x.target, x.installed])
        .filter(([name, target, installed]) => {
        return !!name && !!target && !!installed;
    });
    toInstall.forEach(([name, target, installed]) => {
        logger.info(`Updating package.json with dependency ${name} `
            + `@ ${JSON.stringify(target.version)} (was ${JSON.stringify(installed.version)})...`);
        if (packageJson.dependencies && packageJson.dependencies[name]) {
            packageJson.dependencies[name] = target.version;
            if (packageJson.devDependencies && packageJson.devDependencies[name]) {
                delete packageJson.devDependencies[name];
            }
            if (packageJson.peerDependencies && packageJson.peerDependencies[name]) {
                delete packageJson.peerDependencies[name];
            }
        }
        else if (packageJson.devDependencies && packageJson.devDependencies[name]) {
            packageJson.devDependencies[name] = target.version;
            if (packageJson.peerDependencies && packageJson.peerDependencies[name]) {
                delete packageJson.peerDependencies[name];
            }
        }
        else if (packageJson.peerDependencies && packageJson.peerDependencies[name]) {
            packageJson.peerDependencies[name] = target.version;
        }
        else {
            logger.warn(`Package ${name} was not found in dependencies.`);
        }
    });
    const newContent = JSON.stringify(packageJson, null, 2);
    if (packageJsonContent.toString() != newContent || migrateOnly) {
        let installTask = [];
        if (!migrateOnly) {
            // If something changed, also hook up the task.
            tree.overwrite('/package.json', JSON.stringify(packageJson, null, 2));
            installTask = [context.addTask(new tasks_1.NodePackageInstallTask())];
        }
        // Run the migrate schematics with the list of packages to use. The collection contains
        // version information and we need to do this post installation. Please note that the
        // migration COULD fail and leave side effects on disk.
        // Run the schematics task of those packages.
        toInstall.forEach(([name, target, installed]) => {
            if (!target.updateMetadata.migrations) {
                return;
            }
            const collection = (target.updateMetadata.migrations.match(/^[./]/)
                ? name + '/'
                : '') + target.updateMetadata.migrations;
            context.addTask(new tasks_1.RunSchematicTask('@schematics/update', 'migrate', {
                package: name,
                collection,
                from: installed.version,
                to: target.version,
            }), installTask);
        });
    }
    return rxjs_1.of(undefined);
}
function _migrateOnly(info, context, from, to) {
    if (!info) {
        return rxjs_1.of();
    }
    const target = info.installed;
    if (!target || !target.updateMetadata.migrations) {
        return rxjs_1.of(undefined);
    }
    const collection = (target.updateMetadata.migrations.match(/^[./]/)
        ? info.name + '/'
        : '') + target.updateMetadata.migrations;
    context.addTask(new tasks_1.RunSchematicTask('@schematics/update', 'migrate', {
        package: info.name,
        collection,
        from: from,
        to: to || target.version,
    }));
    return rxjs_1.of(undefined);
}
function _getUpdateMetadata(packageJson, logger) {
    const metadata = packageJson['ng-update'];
    const result = {
        packageGroup: [],
        requirements: {},
    };
    if (!metadata || typeof metadata != 'object' || Array.isArray(metadata)) {
        return result;
    }
    if (metadata['packageGroup']) {
        const packageGroup = metadata['packageGroup'];
        // Verify that packageGroup is an array of strings. This is not an error but we still warn
        // the user and ignore the packageGroup keys.
        if (!Array.isArray(packageGroup) || packageGroup.some(x => typeof x != 'string')) {
            logger.warn(`packageGroup metadata of package ${packageJson.name} is malformed. Ignoring.`);
        }
        else {
            result.packageGroup = packageGroup;
        }
    }
    if (metadata['requirements']) {
        const requirements = metadata['requirements'];
        // Verify that requirements are
        if (typeof requirements != 'object'
            || Array.isArray(requirements)
            || Object.keys(requirements).some(name => typeof requirements[name] != 'string')) {
            logger.warn(`requirements metadata of package ${packageJson.name} is malformed. Ignoring.`);
        }
        else {
            result.requirements = requirements;
        }
    }
    if (metadata['migrations']) {
        const migrations = metadata['migrations'];
        if (typeof migrations != 'string') {
            logger.warn(`migrations metadata of package ${packageJson.name} is malformed. Ignoring.`);
        }
        else {
            result.migrations = migrations;
        }
    }
    return result;
}
function _usageMessage(options, infoMap, logger) {
    const packagesToUpdate = [...infoMap.entries()]
        .sort()
        .map(([name, info]) => {
        const tag = options.next ? 'next' : 'latest';
        const version = info.npmPackageJson['dist-tags'][tag];
        const target = info.npmPackageJson.versions[version];
        return [
            name,
            info,
            version,
            target,
        ];
    })
        .filter(([name, info, version, target]) => {
        return (target && semver.compare(info.installed.version, version) < 0);
    })
        .filter(([, , , target]) => {
        return target['ng-update'];
    });
    if (packagesToUpdate.length == 0) {
        logger.info('We analyzed your package.json and everything seems to be in order. Good work!');
        return rxjs_1.of(undefined);
    }
    logger.info('We analyzed your package.json, there are some packages to update:\n');
    // Find the largest name to know the padding needed.
    let namePad = Math.max(...[...infoMap.keys()].map(x => x.length)) + 2;
    if (!Number.isFinite(namePad)) {
        namePad = 30;
    }
    logger.info('  '
        + 'Name'.padEnd(namePad)
        + 'Version'.padEnd(25)
        + '  Command to update');
    logger.info(' ' + '-'.repeat(namePad * 2 + 35));
    packagesToUpdate.forEach(([name, info, version, target]) => {
        let command = `npm install ${name}`;
        if (target && target['ng-update']) {
            // Show the ng command only when migrations are supported, otherwise it's a fancy
            // npm install, really.
            command = `ng update ${name}`;
        }
        logger.info('  '
            + name.padEnd(namePad)
            + `${info.installed.version} -> ${version}`.padEnd(25)
            + '  ' + command);
    });
    logger.info('\n');
    logger.info('There might be additional packages that are outdated.');
    logger.info('Or run ng update --all to try to update all at the same time.\n');
    return rxjs_1.of(undefined);
}
function _buildPackageInfo(tree, packages, allDependencies, npmPackageJson, logger) {
    const name = npmPackageJson.name;
    const packageJsonRange = allDependencies.get(name);
    if (!packageJsonRange) {
        throw new schematics_1.SchematicsException(`Package ${JSON.stringify(name)} was not found in package.json.`);
    }
    // Find out the currently installed version. Either from the package.json or the node_modules/
    // TODO: figure out a way to read package-lock.json and/or yarn.lock.
    let installedVersion;
    const packageContent = tree.read(`/node_modules/${name}/package.json`);
    if (packageContent) {
        const content = JSON.parse(packageContent.toString());
        installedVersion = content.version;
    }
    if (!installedVersion) {
        // Find the version from NPM that fits the range to max.
        installedVersion = semver.maxSatisfying(Object.keys(npmPackageJson.versions), packageJsonRange);
    }
    const installedPackageJson = npmPackageJson.versions[installedVersion] || packageContent;
    if (!installedPackageJson) {
        throw new schematics_1.SchematicsException(`An unexpected error happened; package ${name} has no version ${installedVersion}.`);
    }
    let targetVersion = packages.get(name);
    if (targetVersion) {
        if (npmPackageJson['dist-tags'][targetVersion]) {
            targetVersion = npmPackageJson['dist-tags'][targetVersion];
        }
        else {
            targetVersion = semver.maxSatisfying(Object.keys(npmPackageJson.versions), targetVersion);
        }
    }
    if (targetVersion && semver.lte(targetVersion, installedVersion)) {
        logger.debug(`Package ${name} already satisfied by package.json (${packageJsonRange}).`);
        targetVersion = undefined;
    }
    const target = targetVersion
        ? {
            version: targetVersion,
            packageJson: npmPackageJson.versions[targetVersion],
            updateMetadata: _getUpdateMetadata(npmPackageJson.versions[targetVersion], logger),
        }
        : undefined;
    // Check if there's an installed version.
    return {
        name,
        npmPackageJson,
        installed: {
            version: installedVersion,
            packageJson: installedPackageJson,
            updateMetadata: _getUpdateMetadata(installedPackageJson, logger),
        },
        target,
        packageJsonRange,
    };
}
function _buildPackageList(options, projectDeps, logger) {
    // Parse the packages options to set the targeted version.
    const packages = new Map();
    const commandLinePackages = (options.packages && options.packages.length > 0)
        ? options.packages
        : (options.all ? projectDeps.keys() : []);
    for (const pkg of commandLinePackages) {
        // Split the version asked on command line.
        const m = pkg.match(/^((?:@[^/]{1,100}\/)?[^@]{1,100})(?:@(.{1,100}))?$/);
        if (!m) {
            logger.warn(`Invalid package argument: ${JSON.stringify(pkg)}. Skipping.`);
            continue;
        }
        const [, npmName, maybeVersion] = m;
        const version = projectDeps.get(npmName);
        if (!version) {
            logger.warn(`Package not installed: ${JSON.stringify(npmName)}. Skipping.`);
            continue;
        }
        // Verify that people have an actual version in the package.json, otherwise (label or URL or
        // gist or ...) we don't update it.
        if (version.startsWith('http:') // HTTP
            || version.startsWith('file:') // Local folder
            || version.startsWith('git:') // GIT url
            || version.match(/^\w{1,100}\/\w{1,100}/) // GitHub's "user/repo"
            || version.match(/^(?:\.{0,2}\/)\w{1,100}/) // Local folder, maybe relative.
        ) {
            // We only do that for --all. Otherwise we have the installed version and the user specified
            // it on the command line.
            if (options.all) {
                logger.warn(`Package ${JSON.stringify(npmName)} has a custom version: `
                    + `${JSON.stringify(version)}. Skipping.`);
                continue;
            }
        }
        packages.set(npmName, (maybeVersion || (options.next ? 'next' : 'latest')));
    }
    return packages;
}
function _addPackageGroup(packages, allDependencies, npmPackageJson, logger) {
    const maybePackage = packages.get(npmPackageJson.name);
    if (!maybePackage) {
        return;
    }
    const version = npmPackageJson['dist-tags'][maybePackage] || maybePackage;
    if (!npmPackageJson.versions[version]) {
        return;
    }
    const ngUpdateMetadata = npmPackageJson.versions[version]['ng-update'];
    if (!ngUpdateMetadata) {
        return;
    }
    const packageGroup = ngUpdateMetadata['packageGroup'];
    if (!packageGroup) {
        return;
    }
    if (!Array.isArray(packageGroup) || packageGroup.some(x => typeof x != 'string')) {
        logger.warn(`packageGroup metadata of package ${npmPackageJson.name} is malformed.`);
        return;
    }
    packageGroup
        .filter(name => !packages.has(name)) // Don't override names from the command line.
        .filter(name => allDependencies.has(name)) // Remove packages that aren't installed.
        .forEach(name => {
        packages.set(name, maybePackage);
    });
}
/**
 * Add peer dependencies of packages on the command line to the list of packages to update.
 * We don't do verification of the versions here as this will be done by a later step (and can
 * be ignored by the --force flag).
 * @private
 */
function _addPeerDependencies(packages, _allDependencies, npmPackageJson, _logger) {
    const maybePackage = packages.get(npmPackageJson.name);
    if (!maybePackage) {
        return;
    }
    const version = npmPackageJson['dist-tags'][maybePackage] || maybePackage;
    if (!npmPackageJson.versions[version]) {
        return;
    }
    const packageJson = npmPackageJson.versions[version];
    const error = false;
    for (const [peer, range] of Object.entries(packageJson.peerDependencies || {})) {
        if (!packages.has(peer)) {
            packages.set(peer, range);
        }
    }
    if (error) {
        throw new schematics_1.SchematicsException('An error occured, see above.');
    }
}
function _getAllDependencies(tree) {
    const packageJsonContent = tree.read('/package.json');
    if (!packageJsonContent) {
        throw new schematics_1.SchematicsException('Could not find a package.json. Are you in a Node project?');
    }
    let packageJson;
    try {
        packageJson = JSON.parse(packageJsonContent.toString());
    }
    catch (e) {
        throw new schematics_1.SchematicsException('package.json could not be parsed: ' + e.message);
    }
    return new Map([
        ...Object.entries(packageJson.peerDependencies || {}),
        ...Object.entries(packageJson.devDependencies || {}),
        ...Object.entries(packageJson.dependencies || {}),
    ]);
}
function default_1(options) {
    if (!options.packages) {
        // We cannot just return this because we need to fetch the packages from NPM still for the
        // help/guide to show.
        options.packages = [];
    }
    else if (typeof options.packages == 'string') {
        // If a string, then we should split it and make it an array.
        options.packages = options.packages.split(/,/g);
    }
    if (options.migrateOnly && options.from) {
        if (options.packages.length !== 1) {
            throw new schematics_1.SchematicsException('--from requires that only a single package be passed.');
        }
    }
    return (tree, context) => {
        const logger = context.logger;
        const allDependencies = _getAllDependencies(tree);
        const packages = _buildPackageList(options, allDependencies, logger);
        return rxjs_1.from([...allDependencies.keys()]).pipe(
        // Grab all package.json from the npm repository. This requires a lot of HTTP calls so we
        // try to parallelize as many as possible.
        operators_1.mergeMap(depName => npm_1.getNpmPackageJson(depName, logger)), 
        // Build a map of all dependencies and their packageJson.
        operators_1.reduce((acc, npmPackageJson) => acc.set(npmPackageJson.name, npmPackageJson), new Map()), operators_1.map(npmPackageJsonMap => {
            // Augment the command line package list with packageGroups and forward peer dependencies.
            npmPackageJsonMap.forEach((npmPackageJson) => {
                _addPackageGroup(packages, allDependencies, npmPackageJson, logger);
                _addPeerDependencies(packages, allDependencies, npmPackageJson, logger);
            });
            // Build the PackageInfo for each module.
            const packageInfoMap = new Map();
            npmPackageJsonMap.forEach((npmPackageJson) => {
                packageInfoMap.set(npmPackageJson.name, _buildPackageInfo(tree, packages, allDependencies, npmPackageJson, logger));
            });
            return packageInfoMap;
        }), operators_1.switchMap(infoMap => {
            // Now that we have all the information, check the flags.
            if (packages.size > 0) {
                if (options.migrateOnly && options.from && options.packages) {
                    return _migrateOnly(infoMap.get(options.packages[0]), context, options.from, options.to);
                }
                const sublog = new core_1.logging.LevelCapLogger('validation', logger.createChild(''), 'warn');
                _validateUpdatePackages(infoMap, options.force, sublog);
                return _performUpdate(tree, context, infoMap, logger, options.migrateOnly);
            }
            else {
                return _usageMessage(options, infoMap, logger);
            }
        }), operators_1.switchMap(() => rxjs_1.of(tree)));
    };
}
exports.default = default_1;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiLi8iLCJzb3VyY2VzIjpbInBhY2thZ2VzL3NjaGVtYXRpY3MvdXBkYXRlL3VwZGF0ZS9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBOzs7Ozs7R0FNRztBQUNILCtDQUErQztBQUMvQywyREFHb0M7QUFDcEMsNERBQTRGO0FBQzVGLCtCQUE4RDtBQUM5RCw4Q0FBa0U7QUFDbEUsaUNBQWlDO0FBQ2pDLCtCQUEwQztBQTJCMUMsMENBQ0UsSUFBWSxFQUNaLE9BQWlDLEVBQ2pDLEtBQStCLEVBQy9CLE1BQXlCO0lBRXpCLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbEQsTUFBTSxDQUFDLEtBQUssQ0FBQyx5QkFBeUIsSUFBSSxLQUFLLENBQUMsQ0FBQztRQUNqRCxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3hDLEVBQUUsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQztZQUNuQixNQUFNLENBQUMsS0FBSyxDQUFDO2dCQUNYLFdBQVcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsbUNBQW1DO2dCQUNsRSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsR0FBRzthQUN0RCxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBRWIsTUFBTSxDQUFDLElBQUksQ0FBQztRQUNkLENBQUM7UUFFRCxNQUFNLFdBQVcsR0FBRyxhQUFhLENBQUMsTUFBTSxJQUFJLGFBQWEsQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLE9BQU87WUFDbEYsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLE9B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LEVBQ1AsT0FBTyxDQUFDLElBQUksRUFDWixPQUFPLENBQUMsRUFBRSxDQUNYLENBQUM7Z0JBQ0osQ0FBQztnQkFFRCxNQUFNLE1BQU0sR0FBRyxJQUFJLGNBQU8sQ0FBQyxjQUFjLENBQ3ZDLFlBQVksRUFDWixNQUFNLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxFQUN0QixNQUFNLENBQ1AsQ0FBQztnQkFDRix1QkFBdUIsQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDLEtBQUssRUFBRSxNQUFNLENBQUMsQ0FBQztnQkFFeEQsTUFBTSxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1lBQzdFLENBQUM7WUFBQyxJQUFJLENBQUMsQ0FBQztnQkFDTixNQUFNLENBQUMsYUFBYSxDQUFDLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxDQUFDLENBQUM7WUFDakQsQ0FBQztRQUNILENBQUMsQ0FBQyxFQUVGLHFCQUFTLENBQUMsR0FBRyxFQUFFLENBQUMsU0FBRSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQzFCLENBQUM7SUFDSixDQUFDLENBQUM7QUFDSixDQUFDO0FBL0VELDRCQStFQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQGxpY2Vuc2VcbiAqIENvcHlyaWdodCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuICpcbiAqIFVzZSBvZiB0aGlzIHNvdXJjZSBjb2RlIGlzIGdvdmVybmVkIGJ5IGFuIE1JVC1zdHlsZSBsaWNlbnNlIHRoYXQgY2FuIGJlXG4gKiBmb3VuZCBpbiB0aGUgTElDRU5TRSBmaWxlIGF0IGh0dHBzOi8vYW5ndWxhci5pby9saWNlbnNlXG4gKi9cbmltcG9ydCB7IGxvZ2dpbmcgfSBmcm9tICdAYW5ndWxhci1kZXZraXQvY29yZSc7XG5pbXBvcnQge1xuICBSdWxlLCBTY2hlbWF0aWNDb250ZXh0LCBTY2hlbWF0aWNzRXhjZXB0aW9uLCBUYXNrSWQsXG4gIFRyZWUsXG59IGZyb20gJ0Bhbmd1bGFyLWRldmtpdC9zY2hlbWF0aWNzJztcbmltcG9ydCB7IE5vZGVQYWNrYWdlSW5zdGFsbFRhc2ssIFJ1blNjaGVtYXRpY1Rhc2sgfSBmcm9tICdAYW5ndWxhci1kZXZraXQvc2NoZW1hdGljcy90YXNrcyc7XG5pbXBvcnQgeyBPYnNlcnZhYmxlLCBmcm9tIGFzIG9ic2VydmFibGVGcm9tLCBvZiB9IGZyb20gJ3J4anMnO1xuaW1wb3J0IHsgbWFwLCBtZXJnZU1hcCwgcmVkdWNlLCBzd2l0Y2hNYXAgfSBmcm9tICdyeGpzL29wZXJhdG9ycyc7XG5pbXBvcnQgKiBhcyBzZW12ZXIgZnJvbSAnc2VtdmVyJztcbmltcG9ydCB7IGdldE5wbVBhY2thZ2VKc29uIH0gZnJvbSAnLi9ucG0nO1xuaW1wb3J0IHsgTnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uIH0gZnJvbSAnLi9ucG0tcGFja2FnZS1qc29uJztcbmltcG9ydCB7IEpzb25TY2hlbWFGb3JOcG1QYWNrYWdlSnNvbkZpbGVzIH0gZnJvbSAnLi9wYWNrYWdlLWpzb24nO1xuaW1wb3J0IHsgVXBkYXRlU2NoZW1hIH0gZnJvbSAnLi9zY2hlbWEnO1xuXG50eXBlIFZlcnNpb25SYW5nZSA9IHN0cmluZyAmIHsgX186IHZvaWQ7IH07XG5cbmludGVyZmFjZSBQYWNrYWdlVmVyc2lvbkluZm8ge1xuICB2ZXJzaW9uOiBWZXJzaW9uUmFuZ2U7XG4gIHBhY2thZ2VKc29uOiBKc29uU2NoZW1hRm9yTnBtUGFja2FnZUpzb25GaWxlcztcbiAgdXBkYXRlTWV0YWRhdGE6IFVwZGF0ZU1ldGFkYXRhO1xufVxuXG5pbnRlcmZhY2UgUGFja2FnZUluZm8ge1xuICBuYW1lOiBzdHJpbmc7XG4gIG5wbVBhY2thZ2VKc29uOiBOcG1SZXBvc2l0b3J5UGFja2FnZUpzb247XG4gIGluc3RhbGxlZDogUGFja2FnZVZlcnNpb25JbmZvO1xuICB0YXJnZXQ/OiBQYWNrYWdlVmVyc2lvbkluZm87XG4gIHBhY2thZ2VKc29uUmFuZ2U6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFVwZGF0ZU1ldGFkYXRhIHtcbiAgcGFja2FnZUdyb3VwOiBzdHJpbmdbXTtcbiAgcmVxdWlyZW1lbnRzOiB7IFtwYWNrYWdlTmFtZTogc3RyaW5nXTogc3RyaW5nIH07XG4gIG1pZ3JhdGlvbnM/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIF92YWxpZGF0ZUZvcndhcmRQZWVyRGVwZW5kZW5jaWVzKFxuICBuYW1lOiBzdHJpbmcsXG4gIGluZm9NYXA6IE1hcDxzdHJpbmcsIFBhY2thZ2VJbmZvPixcbiAgcGVlcnM6IHtbbmFtZTogc3RyaW5nXTogc3RyaW5nfSxcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IGJvb2xlYW4ge1xuICBmb3IgKGNvbnN0IFtwZWVyLCByYW5nZV0gb2YgT2JqZWN0LmVudHJpZXMocGVlcnMpKSB7XG4gICAgbG9nZ2VyLmRlYnVnKGBDaGVja2luZyBmb3J3YXJkIHBlZXIgJHtwZWVyfS4uLmApO1xuICAgIGNvbnN0IG1heWJlUGVlckluZm8gPSBpbmZvTWFwLmdldChwZWVyKTtcbiAgICBpZiAoIW1heWJlUGVlckluZm8pIHtcbiAgICAgIGxvZ2dlci5lcnJvcihbXG4gICAgICAgIGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkobmFtZSl9IGhhcyBhIG1pc3NpbmcgcGVlciBkZXBlbmRlbmN5IG9mYCxcbiAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkocGVlcil9IEAgJHtKU09OLnN0cmluZ2lmeShyYW5nZSl9LmAsXG4gICAgICBdLmpvaW4oJyAnKSk7XG5cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHBlZXJWZXJzaW9uID0gbWF5YmVQZWVySW5mby50YXJnZXQgJiYgbWF5YmVQZWVySW5mby50YXJnZXQucGFja2FnZUpzb24udmVyc2lvblxuICAgICAgPyBtYXliZVBlZXJJbmZvLnRhcmdldC5wYWNrYWdlSnNvbi52ZXJzaW9uXG4gICAgICA6IG1heWJlUGVlckluZm8uaW5zdGFsbGVkLnZlcnNpb247XG5cbiAgICBsb2dnZXIuZGVidWcoYCAgUmFuZ2UgaW50ZXJzZWN0cygke3JhbmdlfSwgJHtwZWVyVmVyc2lvbn0pLi4uYCk7XG4gICAgaWYgKCFzZW12ZXIuc2F0aXNmaWVzKHBlZXJWZXJzaW9uLCByYW5nZSkpIHtcbiAgICAgIGxvZ2dlci5lcnJvcihbXG4gICAgICAgIGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkobmFtZSl9IGhhcyBhbiBpbmNvbXBhdGlibGUgcGVlciBkZXBlbmRlbmN5IHRvYCxcbiAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkocGVlcil9IChyZXF1aXJlcyAke0pTT04uc3RyaW5naWZ5KHJhbmdlKX0sYCxcbiAgICAgICAgYHdvdWxkIGluc3RhbGwgJHtKU09OLnN0cmluZ2lmeShwZWVyVmVyc2lvbil9KWAsXG4gICAgICBdLmpvaW4oJyAnKSk7XG5cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuXG5mdW5jdGlvbiBfdmFsaWRhdGVSZXZlcnNlUGVlckRlcGVuZGVuY2llcyhcbiAgbmFtZTogc3RyaW5nLFxuICB2ZXJzaW9uOiBzdHJpbmcsXG4gIGluZm9NYXA6IE1hcDxzdHJpbmcsIFBhY2thZ2VJbmZvPixcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbikge1xuICBmb3IgKGNvbnN0IFtpbnN0YWxsZWQsIGluc3RhbGxlZEluZm9dIG9mIGluZm9NYXAuZW50cmllcygpKSB7XG4gICAgY29uc3QgaW5zdGFsbGVkTG9nZ2VyID0gbG9nZ2VyLmNyZWF0ZUNoaWxkKGluc3RhbGxlZCk7XG4gICAgaW5zdGFsbGVkTG9nZ2VyLmRlYnVnKGAke2luc3RhbGxlZH0uLi5gKTtcbiAgICBjb25zdCBwZWVycyA9IChpbnN0YWxsZWRJbmZvLnRhcmdldCB8fCBpbnN0YWxsZWRJbmZvLmluc3RhbGxlZCkucGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llcztcblxuICAgIGZvciAoY29uc3QgW3BlZXIsIHJhbmdlXSBvZiBPYmplY3QuZW50cmllcyhwZWVycyB8fCB7fSkpIHtcbiAgICAgIGlmIChwZWVyICE9IG5hbWUpIHtcbiAgICAgICAgLy8gT25seSBjaGVjayBwZWVycyB0byB0aGUgcGFja2FnZXMgd2UncmUgdXBkYXRpbmcuIFdlIGRvbid0IGNhcmUgYWJvdXQgcGVlcnNcbiAgICAgICAgLy8gdGhhdCBhcmUgdW5tZXQgYnV0IHdlIGhhdmUgbm8gZWZmZWN0IG9uLlxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFzZW12ZXIuc2F0aXNmaWVzKHZlcnNpb24sIHJhbmdlKSkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoW1xuICAgICAgICAgIGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkoaW5zdGFsbGVkKX0gaGFzIGFuIGluY29tcGF0aWJsZSBwZWVyIGRlcGVuZGVuY3kgdG9gLFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KG5hbWUpfSAocmVxdWlyZXMgJHtKU09OLnN0cmluZ2lmeShyYW5nZSl9LGAsXG4gICAgICAgICAgYHdvdWxkIGluc3RhbGwgJHtKU09OLnN0cmluZ2lmeSh2ZXJzaW9uKX0pLmAsXG4gICAgICAgIF0uam9pbignICcpKTtcblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIF92YWxpZGF0ZVVwZGF0ZVBhY2thZ2VzKFxuICBpbmZvTWFwOiBNYXA8c3RyaW5nLCBQYWNrYWdlSW5mbz4sXG4gIGZvcmNlOiBib29sZWFuLFxuICBsb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuKTogdm9pZCB7XG4gIGxvZ2dlci5kZWJ1ZygnVXBkYXRpbmcgdGhlIGZvbGxvd2luZyBwYWNrYWdlczonKTtcbiAgaW5mb01hcC5mb3JFYWNoKGluZm8gPT4ge1xuICAgIGlmIChpbmZvLnRhcmdldCkge1xuICAgICAgbG9nZ2VyLmRlYnVnKGAgICR7aW5mby5uYW1lfSA9PiAke2luZm8udGFyZ2V0LnZlcnNpb259YCk7XG4gICAgfVxuICB9KTtcblxuICBsZXQgcGVlckVycm9ycyA9IGZhbHNlO1xuICBpbmZvTWFwLmZvckVhY2goaW5mbyA9PiB7XG4gICAgY29uc3Qge25hbWUsIHRhcmdldH0gPSBpbmZvO1xuICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcGtnTG9nZ2VyID0gbG9nZ2VyLmNyZWF0ZUNoaWxkKG5hbWUpO1xuICAgIGxvZ2dlci5kZWJ1ZyhgJHtuYW1lfS4uLmApO1xuXG4gICAgY29uc3QgcGVlcnMgPSB0YXJnZXQucGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llcyB8fCB7fTtcbiAgICBwZWVyRXJyb3JzID0gX3ZhbGlkYXRlRm9yd2FyZFBlZXJEZXBlbmRlbmNpZXMobmFtZSwgaW5mb01hcCwgcGVlcnMsIHBrZ0xvZ2dlcikgfHwgcGVlckVycm9ycztcbiAgICBwZWVyRXJyb3JzXG4gICAgICA9IF92YWxpZGF0ZVJldmVyc2VQZWVyRGVwZW5kZW5jaWVzKG5hbWUsIHRhcmdldC52ZXJzaW9uLCBpbmZvTWFwLCBwa2dMb2dnZXIpXG4gICAgICB8fCBwZWVyRXJyb3JzO1xuICB9KTtcblxuICBpZiAoIWZvcmNlICYmIHBlZXJFcnJvcnMpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbihgSW5jb21wYXRpYmxlIHBlZXIgZGVwZW5kZW5jaWVzIGZvdW5kLiBTZWUgYWJvdmUuYCk7XG4gIH1cbn1cblxuXG5mdW5jdGlvbiBfcGVyZm9ybVVwZGF0ZShcbiAgdHJlZTogVHJlZSxcbiAgY29udGV4dDogU2NoZW1hdGljQ29udGV4dCxcbiAgaW5mb01hcDogTWFwPHN0cmluZywgUGFja2FnZUluZm8+LFxuICBsb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuICBtaWdyYXRlT25seTogYm9vbGVhbixcbik6IE9ic2VydmFibGU8dm9pZD4ge1xuICBjb25zdCBwYWNrYWdlSnNvbkNvbnRlbnQgPSB0cmVlLnJlYWQoJy9wYWNrYWdlLmpzb24nKTtcbiAgaWYgKCFwYWNrYWdlSnNvbkNvbnRlbnQpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbignQ291bGQgbm90IGZpbmQgYSBwYWNrYWdlLmpzb24uIEFyZSB5b3UgaW4gYSBOb2RlIHByb2plY3Q/Jyk7XG4gIH1cblxuICBsZXQgcGFja2FnZUpzb246IEpzb25TY2hlbWFGb3JOcG1QYWNrYWdlSnNvbkZpbGVzO1xuICB0cnkge1xuICAgIHBhY2thZ2VKc29uID0gSlNPTi5wYXJzZShwYWNrYWdlSnNvbkNvbnRlbnQudG9TdHJpbmcoKSkgYXMgSnNvblNjaGVtYUZvck5wbVBhY2thZ2VKc29uRmlsZXM7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbigncGFja2FnZS5qc29uIGNvdWxkIG5vdCBiZSBwYXJzZWQ6ICcgKyBlLm1lc3NhZ2UpO1xuICB9XG5cbiAgY29uc3QgdG9JbnN0YWxsID0gWy4uLmluZm9NYXAudmFsdWVzKCldXG4gICAgICAubWFwKHggPT4gW3gubmFtZSwgeC50YXJnZXQsIHguaW5zdGFsbGVkXSlcbiAgICAgIC8vIHRzbGludDpkaXNhYmxlLW5leHQtbGluZTpub24tbnVsbC1vcGVyYXRvclxuICAgICAgLmZpbHRlcigoW25hbWUsIHRhcmdldCwgaW5zdGFsbGVkXSkgPT4ge1xuICAgICAgICByZXR1cm4gISFuYW1lICYmICEhdGFyZ2V0ICYmICEhaW5zdGFsbGVkO1xuICAgICAgfSkgYXMgW3N0cmluZywgUGFja2FnZVZlcnNpb25JbmZvLCBQYWNrYWdlVmVyc2lvbkluZm9dW107XG5cbiAgdG9JbnN0YWxsLmZvckVhY2goKFtuYW1lLCB0YXJnZXQsIGluc3RhbGxlZF0pID0+IHtcbiAgICBsb2dnZXIuaW5mbyhcbiAgICAgIGBVcGRhdGluZyBwYWNrYWdlLmpzb24gd2l0aCBkZXBlbmRlbmN5ICR7bmFtZX0gYFxuICAgICAgKyBgQCAke0pTT04uc3RyaW5naWZ5KHRhcmdldC52ZXJzaW9uKX0gKHdhcyAke0pTT04uc3RyaW5naWZ5KGluc3RhbGxlZC52ZXJzaW9uKX0pLi4uYCxcbiAgICApO1xuXG4gICAgaWYgKHBhY2thZ2VKc29uLmRlcGVuZGVuY2llcyAmJiBwYWNrYWdlSnNvbi5kZXBlbmRlbmNpZXNbbmFtZV0pIHtcbiAgICAgIHBhY2thZ2VKc29uLmRlcGVuZGVuY2llc1tuYW1lXSA9IHRhcmdldC52ZXJzaW9uO1xuXG4gICAgICBpZiAocGFja2FnZUpzb24uZGV2RGVwZW5kZW5jaWVzICYmIHBhY2thZ2VKc29uLmRldkRlcGVuZGVuY2llc1tuYW1lXSkge1xuICAgICAgICBkZWxldGUgcGFja2FnZUpzb24uZGV2RGVwZW5kZW5jaWVzW25hbWVdO1xuICAgICAgfVxuICAgICAgaWYgKHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXMgJiYgcGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llc1tuYW1lXSkge1xuICAgICAgICBkZWxldGUgcGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llc1tuYW1lXTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VKc29uLmRldkRlcGVuZGVuY2llcyAmJiBwYWNrYWdlSnNvbi5kZXZEZXBlbmRlbmNpZXNbbmFtZV0pIHtcbiAgICAgIHBhY2thZ2VKc29uLmRldkRlcGVuZGVuY2llc1tuYW1lXSA9IHRhcmdldC52ZXJzaW9uO1xuXG4gICAgICBpZiAocGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llcyAmJiBwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzW25hbWVdKSB7XG4gICAgICAgIGRlbGV0ZSBwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzW25hbWVdO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAocGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llcyAmJiBwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzW25hbWVdKSB7XG4gICAgICBwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzW25hbWVdID0gdGFyZ2V0LnZlcnNpb247XG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZ2dlci53YXJuKGBQYWNrYWdlICR7bmFtZX0gd2FzIG5vdCBmb3VuZCBpbiBkZXBlbmRlbmNpZXMuYCk7XG4gICAgfVxuICB9KTtcblxuICBjb25zdCBuZXdDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkocGFja2FnZUpzb24sIG51bGwsIDIpO1xuICBpZiAocGFja2FnZUpzb25Db250ZW50LnRvU3RyaW5nKCkgIT0gbmV3Q29udGVudCB8fCBtaWdyYXRlT25seSkge1xuICAgIGxldCBpbnN0YWxsVGFzazogVGFza0lkW10gPSBbXTtcbiAgICBpZiAoIW1pZ3JhdGVPbmx5KSB7XG4gICAgICAvLyBJZiBzb21ldGhpbmcgY2hhbmdlZCwgYWxzbyBob29rIHVwIHRoZSB0YXNrLlxuICAgICAgdHJlZS5vdmVyd3JpdGUoJy9wYWNrYWdlLmpzb24nLCBKU09OLnN0cmluZ2lmeShwYWNrYWdlSnNvbiwgbnVsbCwgMikpO1xuICAgICAgaW5zdGFsbFRhc2sgPSBbY29udGV4dC5hZGRUYXNrKG5ldyBOb2RlUGFja2FnZUluc3RhbGxUYXNrKCkpXTtcbiAgICB9XG5cbiAgICAvLyBSdW4gdGhlIG1pZ3JhdGUgc2NoZW1hdGljcyB3aXRoIHRoZSBsaXN0IG9mIHBhY2thZ2VzIHRvIHVzZS4gVGhlIGNvbGxlY3Rpb24gY29udGFpbnNcbiAgICAvLyB2ZXJzaW9uIGluZm9ybWF0aW9uIGFuZCB3ZSBuZWVkIHRvIGRvIHRoaXMgcG9zdCBpbnN0YWxsYXRpb24uIFBsZWFzZSBub3RlIHRoYXQgdGhlXG4gICAgLy8gbWlncmF0aW9uIENPVUxEIGZhaWwgYW5kIGxlYXZlIHNpZGUgZWZmZWN0cyBvbiBkaXNrLlxuICAgIC8vIFJ1biB0aGUgc2NoZW1hdGljcyB0YXNrIG9mIHRob3NlIHBhY2thZ2VzLlxuICAgIHRvSW5zdGFsbC5mb3JFYWNoKChbbmFtZSwgdGFyZ2V0LCBpbnN0YWxsZWRdKSA9PiB7XG4gICAgICBpZiAoIXRhcmdldC51cGRhdGVNZXRhZGF0YS5taWdyYXRpb25zKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY29sbGVjdGlvbiA9IChcbiAgICAgICAgdGFyZ2V0LnVwZGF0ZU1ldGFkYXRhLm1pZ3JhdGlvbnMubWF0Y2goL15bLi9dLylcbiAgICAgICAgPyBuYW1lICsgJy8nXG4gICAgICAgIDogJydcbiAgICAgICkgKyB0YXJnZXQudXBkYXRlTWV0YWRhdGEubWlncmF0aW9ucztcblxuICAgICAgY29udGV4dC5hZGRUYXNrKG5ldyBSdW5TY2hlbWF0aWNUYXNrKCdAc2NoZW1hdGljcy91cGRhdGUnLCAnbWlncmF0ZScsIHtcbiAgICAgICAgICBwYWNrYWdlOiBuYW1lLFxuICAgICAgICAgIGNvbGxlY3Rpb24sXG4gICAgICAgICAgZnJvbTogaW5zdGFsbGVkLnZlcnNpb24sXG4gICAgICAgICAgdG86IHRhcmdldC52ZXJzaW9uLFxuICAgICAgICB9KSxcbiAgICAgICAgaW5zdGFsbFRhc2ssXG4gICAgICApO1xuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIG9mPHZvaWQ+KHVuZGVmaW5lZCk7XG59XG5cbmZ1bmN0aW9uIF9taWdyYXRlT25seShcbiAgaW5mbzogUGFja2FnZUluZm8gfCB1bmRlZmluZWQsXG4gIGNvbnRleHQ6IFNjaGVtYXRpY0NvbnRleHQsXG4gIGZyb206IHN0cmluZyxcbiAgdG8/OiBzdHJpbmcsXG4pIHtcbiAgaWYgKCFpbmZvKSB7XG4gICAgcmV0dXJuIG9mPHZvaWQ+KCk7XG4gIH1cblxuICBjb25zdCB0YXJnZXQgPSBpbmZvLmluc3RhbGxlZDtcbiAgaWYgKCF0YXJnZXQgfHwgIXRhcmdldC51cGRhdGVNZXRhZGF0YS5taWdyYXRpb25zKSB7XG4gICAgcmV0dXJuIG9mPHZvaWQ+KHVuZGVmaW5lZCk7XG4gIH1cblxuICBjb25zdCBjb2xsZWN0aW9uID0gKFxuICAgIHRhcmdldC51cGRhdGVNZXRhZGF0YS5taWdyYXRpb25zLm1hdGNoKC9eWy4vXS8pXG4gICAgICA/IGluZm8ubmFtZSArICcvJ1xuICAgICAgOiAnJ1xuICApICsgdGFyZ2V0LnVwZGF0ZU1ldGFkYXRhLm1pZ3JhdGlvbnM7XG5cbiAgY29udGV4dC5hZGRUYXNrKG5ldyBSdW5TY2hlbWF0aWNUYXNrKCdAc2NoZW1hdGljcy91cGRhdGUnLCAnbWlncmF0ZScsIHtcbiAgICAgIHBhY2thZ2U6IGluZm8ubmFtZSxcbiAgICAgIGNvbGxlY3Rpb24sXG4gICAgICBmcm9tOiBmcm9tLFxuICAgICAgdG86IHRvIHx8IHRhcmdldC52ZXJzaW9uLFxuICAgIH0pLFxuICApO1xuXG4gIHJldHVybiBvZjx2b2lkPih1bmRlZmluZWQpO1xufVxuXG5mdW5jdGlvbiBfZ2V0VXBkYXRlTWV0YWRhdGEoXG4gIHBhY2thZ2VKc29uOiBKc29uU2NoZW1hRm9yTnBtUGFja2FnZUpzb25GaWxlcyxcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IFVwZGF0ZU1ldGFkYXRhIHtcbiAgY29uc3QgbWV0YWRhdGEgPSBwYWNrYWdlSnNvblsnbmctdXBkYXRlJ107XG5cbiAgY29uc3QgcmVzdWx0OiBVcGRhdGVNZXRhZGF0YSA9IHtcbiAgICBwYWNrYWdlR3JvdXA6IFtdLFxuICAgIHJlcXVpcmVtZW50czoge30sXG4gIH07XG5cbiAgaWYgKCFtZXRhZGF0YSB8fCB0eXBlb2YgbWV0YWRhdGEgIT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShtZXRhZGF0YSkpIHtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgaWYgKG1ldGFkYXRhWydwYWNrYWdlR3JvdXAnXSkge1xuICAgIGNvbnN0IHBhY2thZ2VHcm91cCA9IG1ldGFkYXRhWydwYWNrYWdlR3JvdXAnXTtcbiAgICAvLyBWZXJpZnkgdGhhdCBwYWNrYWdlR3JvdXAgaXMgYW4gYXJyYXkgb2Ygc3RyaW5ncy4gVGhpcyBpcyBub3QgYW4gZXJyb3IgYnV0IHdlIHN0aWxsIHdhcm5cbiAgICAvLyB0aGUgdXNlciBhbmQgaWdub3JlIHRoZSBwYWNrYWdlR3JvdXAga2V5cy5cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocGFja2FnZUdyb3VwKSB8fCBwYWNrYWdlR3JvdXAuc29tZSh4ID0+IHR5cGVvZiB4ICE9ICdzdHJpbmcnKSkge1xuICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgIGBwYWNrYWdlR3JvdXAgbWV0YWRhdGEgb2YgcGFja2FnZSAke3BhY2thZ2VKc29uLm5hbWV9IGlzIG1hbGZvcm1lZC4gSWdub3JpbmcuYCxcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdC5wYWNrYWdlR3JvdXAgPSBwYWNrYWdlR3JvdXA7XG4gICAgfVxuICB9XG5cbiAgaWYgKG1ldGFkYXRhWydyZXF1aXJlbWVudHMnXSkge1xuICAgIGNvbnN0IHJlcXVpcmVtZW50cyA9IG1ldGFkYXRhWydyZXF1aXJlbWVudHMnXTtcbiAgICAvLyBWZXJpZnkgdGhhdCByZXF1aXJlbWVudHMgYXJlXG4gICAgaWYgKHR5cGVvZiByZXF1aXJlbWVudHMgIT0gJ29iamVjdCdcbiAgICAgICAgfHwgQXJyYXkuaXNBcnJheShyZXF1aXJlbWVudHMpXG4gICAgICAgIHx8IE9iamVjdC5rZXlzKHJlcXVpcmVtZW50cykuc29tZShuYW1lID0+IHR5cGVvZiByZXF1aXJlbWVudHNbbmFtZV0gIT0gJ3N0cmluZycpKSB7XG4gICAgICBsb2dnZXIud2FybihcbiAgICAgICAgYHJlcXVpcmVtZW50cyBtZXRhZGF0YSBvZiBwYWNrYWdlICR7cGFja2FnZUpzb24ubmFtZX0gaXMgbWFsZm9ybWVkLiBJZ25vcmluZy5gLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0LnJlcXVpcmVtZW50cyA9IHJlcXVpcmVtZW50cztcbiAgICB9XG4gIH1cblxuICBpZiAobWV0YWRhdGFbJ21pZ3JhdGlvbnMnXSkge1xuICAgIGNvbnN0IG1pZ3JhdGlvbnMgPSBtZXRhZGF0YVsnbWlncmF0aW9ucyddO1xuICAgIGlmICh0eXBlb2YgbWlncmF0aW9ucyAhPSAnc3RyaW5nJykge1xuICAgICAgbG9nZ2VyLndhcm4oYG1pZ3JhdGlvbnMgbWV0YWRhdGEgb2YgcGFja2FnZSAke3BhY2thZ2VKc29uLm5hbWV9IGlzIG1hbGZvcm1lZC4gSWdub3JpbmcuYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdC5taWdyYXRpb25zID0gbWlncmF0aW9ucztcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5cbmZ1bmN0aW9uIF91c2FnZU1lc3NhZ2UoXG4gIG9wdGlvbnM6IFVwZGF0ZVNjaGVtYSxcbiAgaW5mb01hcDogTWFwPHN0cmluZywgUGFja2FnZUluZm8+LFxuICBsb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuKSB7XG4gIGNvbnN0IHBhY2thZ2VzVG9VcGRhdGUgPSBbLi4uaW5mb01hcC5lbnRyaWVzKCldXG4gICAgLnNvcnQoKVxuICAgIC5tYXAoKFtuYW1lLCBpbmZvXSkgPT4ge1xuICAgICAgY29uc3QgdGFnID0gb3B0aW9ucy5uZXh0ID8gJ25leHQnIDogJ2xhdGVzdCc7XG4gICAgICBjb25zdCB2ZXJzaW9uID0gaW5mby5ucG1QYWNrYWdlSnNvblsnZGlzdC10YWdzJ11bdGFnXTtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGluZm8ubnBtUGFja2FnZUpzb24udmVyc2lvbnNbdmVyc2lvbl07XG5cbiAgICAgIHJldHVybiBbXG4gICAgICAgIG5hbWUsXG4gICAgICAgIGluZm8sXG4gICAgICAgIHZlcnNpb24sXG4gICAgICAgIHRhcmdldCxcbiAgICAgIF0gYXMgW3N0cmluZywgUGFja2FnZUluZm8sIHN0cmluZywgSnNvblNjaGVtYUZvck5wbVBhY2thZ2VKc29uRmlsZXNdO1xuICAgIH0pXG4gICAgLmZpbHRlcigoW25hbWUsIGluZm8sIHZlcnNpb24sIHRhcmdldF0pID0+IHtcbiAgICAgIHJldHVybiAodGFyZ2V0ICYmIHNlbXZlci5jb21wYXJlKGluZm8uaW5zdGFsbGVkLnZlcnNpb24sIHZlcnNpb24pIDwgMCk7XG4gICAgfSlcbiAgICAuZmlsdGVyKChbLCAsICwgdGFyZ2V0XSkgPT4ge1xuICAgICAgcmV0dXJuIHRhcmdldFsnbmctdXBkYXRlJ107XG4gICAgfSk7XG5cbiAgaWYgKHBhY2thZ2VzVG9VcGRhdGUubGVuZ3RoID09IDApIHtcbiAgICBsb2dnZXIuaW5mbygnV2UgYW5hbHl6ZWQgeW91ciBwYWNrYWdlLmpzb24gYW5kIGV2ZXJ5dGhpbmcgc2VlbXMgdG8gYmUgaW4gb3JkZXIuIEdvb2Qgd29yayEnKTtcblxuICAgIHJldHVybiBvZjx2b2lkPih1bmRlZmluZWQpO1xuICB9XG5cbiAgbG9nZ2VyLmluZm8oXG4gICAgJ1dlIGFuYWx5emVkIHlvdXIgcGFja2FnZS5qc29uLCB0aGVyZSBhcmUgc29tZSBwYWNrYWdlcyB0byB1cGRhdGU6XFxuJyxcbiAgKTtcblxuICAvLyBGaW5kIHRoZSBsYXJnZXN0IG5hbWUgdG8ga25vdyB0aGUgcGFkZGluZyBuZWVkZWQuXG4gIGxldCBuYW1lUGFkID0gTWF0aC5tYXgoLi4uWy4uLmluZm9NYXAua2V5cygpXS5tYXAoeCA9PiB4Lmxlbmd0aCkpICsgMjtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobmFtZVBhZCkpIHtcbiAgICBuYW1lUGFkID0gMzA7XG4gIH1cblxuICBsb2dnZXIuaW5mbyhcbiAgICAnICAnXG4gICAgKyAnTmFtZScucGFkRW5kKG5hbWVQYWQpXG4gICAgKyAnVmVyc2lvbicucGFkRW5kKDI1KVxuICAgICsgJyAgQ29tbWFuZCB0byB1cGRhdGUnLFxuICApO1xuICBsb2dnZXIuaW5mbygnICcgKyAnLScucmVwZWF0KG5hbWVQYWQgKiAyICsgMzUpKTtcblxuICBwYWNrYWdlc1RvVXBkYXRlLmZvckVhY2goKFtuYW1lLCBpbmZvLCB2ZXJzaW9uLCB0YXJnZXRdKSA9PiB7XG4gICAgbGV0IGNvbW1hbmQgPSBgbnBtIGluc3RhbGwgJHtuYW1lfWA7XG4gICAgaWYgKHRhcmdldCAmJiB0YXJnZXRbJ25nLXVwZGF0ZSddKSB7XG4gICAgICAvLyBTaG93IHRoZSBuZyBjb21tYW5kIG9ubHkgd2hlbiBtaWdyYXRpb25zIGFyZSBzdXBwb3J0ZWQsIG90aGVyd2lzZSBpdCdzIGEgZmFuY3lcbiAgICAgIC8vIG5wbSBpbnN0YWxsLCByZWFsbHkuXG4gICAgICBjb21tYW5kID0gYG5nIHVwZGF0ZSAke25hbWV9YDtcbiAgICB9XG5cbiAgICBsb2dnZXIuaW5mbyhcbiAgICAgICcgICdcbiAgICAgICsgbmFtZS5wYWRFbmQobmFtZVBhZClcbiAgICAgICsgYCR7aW5mby5pbnN0YWxsZWQudmVyc2lvbn0gLT4gJHt2ZXJzaW9ufWAucGFkRW5kKDI1KVxuICAgICAgKyAnICAnICsgY29tbWFuZCxcbiAgICApO1xuICB9KTtcblxuICBsb2dnZXIuaW5mbygnXFxuJyk7XG4gIGxvZ2dlci5pbmZvKCdUaGVyZSBtaWdodCBiZSBhZGRpdGlvbmFsIHBhY2thZ2VzIHRoYXQgYXJlIG91dGRhdGVkLicpO1xuICBsb2dnZXIuaW5mbygnT3IgcnVuIG5nIHVwZGF0ZSAtLWFsbCB0byB0cnkgdG8gdXBkYXRlIGFsbCBhdCB0aGUgc2FtZSB0aW1lLlxcbicpO1xuXG4gIHJldHVybiBvZjx2b2lkPih1bmRlZmluZWQpO1xufVxuXG5cbmZ1bmN0aW9uIF9idWlsZFBhY2thZ2VJbmZvKFxuICB0cmVlOiBUcmVlLFxuICBwYWNrYWdlczogTWFwPHN0cmluZywgVmVyc2lvblJhbmdlPixcbiAgYWxsRGVwZW5kZW5jaWVzOiBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+LFxuICBucG1QYWNrYWdlSnNvbjogTnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uLFxuICBsb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuKTogUGFja2FnZUluZm8ge1xuICBjb25zdCBuYW1lID0gbnBtUGFja2FnZUpzb24ubmFtZTtcbiAgY29uc3QgcGFja2FnZUpzb25SYW5nZSA9IGFsbERlcGVuZGVuY2llcy5nZXQobmFtZSk7XG4gIGlmICghcGFja2FnZUpzb25SYW5nZSkge1xuICAgIHRocm93IG5ldyBTY2hlbWF0aWNzRXhjZXB0aW9uKFxuICAgICAgYFBhY2thZ2UgJHtKU09OLnN0cmluZ2lmeShuYW1lKX0gd2FzIG5vdCBmb3VuZCBpbiBwYWNrYWdlLmpzb24uYCxcbiAgICApO1xuICB9XG5cbiAgLy8gRmluZCBvdXQgdGhlIGN1cnJlbnRseSBpbnN0YWxsZWQgdmVyc2lvbi4gRWl0aGVyIGZyb20gdGhlIHBhY2thZ2UuanNvbiBvciB0aGUgbm9kZV9tb2R1bGVzL1xuICAvLyBUT0RPOiBmaWd1cmUgb3V0IGEgd2F5IHRvIHJlYWQgcGFja2FnZS1sb2NrLmpzb24gYW5kL29yIHlhcm4ubG9jay5cbiAgbGV0IGluc3RhbGxlZFZlcnNpb246IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29uc3QgcGFja2FnZUNvbnRlbnQgPSB0cmVlLnJlYWQoYC9ub2RlX21vZHVsZXMvJHtuYW1lfS9wYWNrYWdlLmpzb25gKTtcbiAgaWYgKHBhY2thZ2VDb250ZW50KSB7XG4gICAgY29uc3QgY29udGVudCA9IEpTT04ucGFyc2UocGFja2FnZUNvbnRlbnQudG9TdHJpbmcoKSkgYXMgSnNvblNjaGVtYUZvck5wbVBhY2thZ2VKc29uRmlsZXM7XG4gICAgaW5zdGFsbGVkVmVyc2lvbiA9IGNvbnRlbnQudmVyc2lvbjtcbiAgfVxuICBpZiAoIWluc3RhbGxlZFZlcnNpb24pIHtcbiAgICAvLyBGaW5kIHRoZSB2ZXJzaW9uIGZyb20gTlBNIHRoYXQgZml0cyB0aGUgcmFuZ2UgdG8gbWF4LlxuICAgIGluc3RhbGxlZFZlcnNpb24gPSBzZW12ZXIubWF4U2F0aXNmeWluZyhcbiAgICAgIE9iamVjdC5rZXlzKG5wbVBhY2thZ2VKc29uLnZlcnNpb25zKSxcbiAgICAgIHBhY2thZ2VKc29uUmFuZ2UsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGluc3RhbGxlZFBhY2thZ2VKc29uID0gbnBtUGFja2FnZUpzb24udmVyc2lvbnNbaW5zdGFsbGVkVmVyc2lvbl0gfHwgcGFja2FnZUNvbnRlbnQ7XG4gIGlmICghaW5zdGFsbGVkUGFja2FnZUpzb24pIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbihcbiAgICAgIGBBbiB1bmV4cGVjdGVkIGVycm9yIGhhcHBlbmVkOyBwYWNrYWdlICR7bmFtZX0gaGFzIG5vIHZlcnNpb24gJHtpbnN0YWxsZWRWZXJzaW9ufS5gLFxuICAgICk7XG4gIH1cblxuICBsZXQgdGFyZ2V0VmVyc2lvbjogVmVyc2lvblJhbmdlIHwgdW5kZWZpbmVkID0gcGFja2FnZXMuZ2V0KG5hbWUpO1xuICBpZiAodGFyZ2V0VmVyc2lvbikge1xuICAgIGlmIChucG1QYWNrYWdlSnNvblsnZGlzdC10YWdzJ11bdGFyZ2V0VmVyc2lvbl0pIHtcbiAgICAgIHRhcmdldFZlcnNpb24gPSBucG1QYWNrYWdlSnNvblsnZGlzdC10YWdzJ11bdGFyZ2V0VmVyc2lvbl0gYXMgVmVyc2lvblJhbmdlO1xuICAgIH0gZWxzZSB7XG4gICAgICB0YXJnZXRWZXJzaW9uID0gc2VtdmVyLm1heFNhdGlzZnlpbmcoXG4gICAgICAgIE9iamVjdC5rZXlzKG5wbVBhY2thZ2VKc29uLnZlcnNpb25zKSxcbiAgICAgICAgdGFyZ2V0VmVyc2lvbixcbiAgICAgICkgYXMgVmVyc2lvblJhbmdlO1xuICAgIH1cbiAgfVxuXG4gIGlmICh0YXJnZXRWZXJzaW9uICYmIHNlbXZlci5sdGUodGFyZ2V0VmVyc2lvbiwgaW5zdGFsbGVkVmVyc2lvbikpIHtcbiAgICBsb2dnZXIuZGVidWcoYFBhY2thZ2UgJHtuYW1lfSBhbHJlYWR5IHNhdGlzZmllZCBieSBwYWNrYWdlLmpzb24gKCR7cGFja2FnZUpzb25SYW5nZX0pLmApO1xuICAgIHRhcmdldFZlcnNpb24gPSB1bmRlZmluZWQ7XG4gIH1cblxuICBjb25zdCB0YXJnZXQ6IFBhY2thZ2VWZXJzaW9uSW5mbyB8IHVuZGVmaW5lZCA9IHRhcmdldFZlcnNpb25cbiAgICA/IHtcbiAgICAgIHZlcnNpb246IHRhcmdldFZlcnNpb24sXG4gICAgICBwYWNrYWdlSnNvbjogbnBtUGFja2FnZUpzb24udmVyc2lvbnNbdGFyZ2V0VmVyc2lvbl0sXG4gICAgICB1cGRhdGVNZXRhZGF0YTogX2dldFVwZGF0ZU1ldGFkYXRhKG5wbVBhY2thZ2VKc29uLnZlcnNpb25zW3RhcmdldFZlcnNpb25dLCBsb2dnZXIpLFxuICAgIH1cbiAgICA6IHVuZGVmaW5lZDtcblxuICAvLyBDaGVjayBpZiB0aGVyZSdzIGFuIGluc3RhbGxlZCB2ZXJzaW9uLlxuICByZXR1cm4ge1xuICAgIG5hbWUsXG4gICAgbnBtUGFja2FnZUpzb24sXG4gICAgaW5zdGFsbGVkOiB7XG4gICAgICB2ZXJzaW9uOiBpbnN0YWxsZWRWZXJzaW9uIGFzIFZlcnNpb25SYW5nZSxcbiAgICAgIHBhY2thZ2VKc29uOiBpbnN0YWxsZWRQYWNrYWdlSnNvbixcbiAgICAgIHVwZGF0ZU1ldGFkYXRhOiBfZ2V0VXBkYXRlTWV0YWRhdGEoaW5zdGFsbGVkUGFja2FnZUpzb24sIGxvZ2dlciksXG4gICAgfSxcbiAgICB0YXJnZXQsXG4gICAgcGFja2FnZUpzb25SYW5nZSxcbiAgfTtcbn1cblxuXG5mdW5jdGlvbiBfYnVpbGRQYWNrYWdlTGlzdChcbiAgb3B0aW9uczogVXBkYXRlU2NoZW1hLFxuICBwcm9qZWN0RGVwczogTWFwPHN0cmluZywgVmVyc2lvblJhbmdlPixcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4ge1xuICAvLyBQYXJzZSB0aGUgcGFja2FnZXMgb3B0aW9ucyB0byBzZXQgdGhlIHRhcmdldGVkIHZlcnNpb24uXG4gIGNvbnN0IHBhY2thZ2VzID0gbmV3IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4oKTtcbiAgY29uc3QgY29tbWFuZExpbmVQYWNrYWdlcyA9XG4gICAgKG9wdGlvbnMucGFja2FnZXMgJiYgb3B0aW9ucy5wYWNrYWdlcy5sZW5ndGggPiAwKVxuICAgID8gb3B0aW9ucy5wYWNrYWdlc1xuICAgIDogKG9wdGlvbnMuYWxsID8gcHJvamVjdERlcHMua2V5cygpIDogW10pO1xuXG4gIGZvciAoY29uc3QgcGtnIG9mIGNvbW1hbmRMaW5lUGFja2FnZXMpIHtcbiAgICAvLyBTcGxpdCB0aGUgdmVyc2lvbiBhc2tlZCBvbiBjb21tYW5kIGxpbmUuXG4gICAgY29uc3QgbSA9IHBrZy5tYXRjaCgvXigoPzpAW14vXXsxLDEwMH1cXC8pP1teQF17MSwxMDB9KSg/OkAoLnsxLDEwMH0pKT8kLyk7XG4gICAgaWYgKCFtKSB7XG4gICAgICBsb2dnZXIud2FybihgSW52YWxpZCBwYWNrYWdlIGFyZ3VtZW50OiAke0pTT04uc3RyaW5naWZ5KHBrZyl9LiBTa2lwcGluZy5gKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IFssIG5wbU5hbWUsIG1heWJlVmVyc2lvbl0gPSBtO1xuXG4gICAgY29uc3QgdmVyc2lvbiA9IHByb2plY3REZXBzLmdldChucG1OYW1lKTtcbiAgICBpZiAoIXZlcnNpb24pIHtcbiAgICAgIGxvZ2dlci53YXJuKGBQYWNrYWdlIG5vdCBpbnN0YWxsZWQ6ICR7SlNPTi5zdHJpbmdpZnkobnBtTmFtZSl9LiBTa2lwcGluZy5gKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIFZlcmlmeSB0aGF0IHBlb3BsZSBoYXZlIGFuIGFjdHVhbCB2ZXJzaW9uIGluIHRoZSBwYWNrYWdlLmpzb24sIG90aGVyd2lzZSAobGFiZWwgb3IgVVJMIG9yXG4gICAgLy8gZ2lzdCBvciAuLi4pIHdlIGRvbid0IHVwZGF0ZSBpdC5cbiAgICBpZiAoXG4gICAgICB2ZXJzaW9uLnN0YXJ0c1dpdGgoJ2h0dHA6JykgIC8vIEhUVFBcbiAgICAgIHx8IHZlcnNpb24uc3RhcnRzV2l0aCgnZmlsZTonKSAgLy8gTG9jYWwgZm9sZGVyXG4gICAgICB8fCB2ZXJzaW9uLnN0YXJ0c1dpdGgoJ2dpdDonKSAgLy8gR0lUIHVybFxuICAgICAgfHwgdmVyc2lvbi5tYXRjaCgvXlxcd3sxLDEwMH1cXC9cXHd7MSwxMDB9LykgIC8vIEdpdEh1YidzIFwidXNlci9yZXBvXCJcbiAgICAgIHx8IHZlcnNpb24ubWF0Y2goL14oPzpcXC57MCwyfVxcLylcXHd7MSwxMDB9LykgIC8vIExvY2FsIGZvbGRlciwgbWF5YmUgcmVsYXRpdmUuXG4gICAgKSB7XG4gICAgICAvLyBXZSBvbmx5IGRvIHRoYXQgZm9yIC0tYWxsLiBPdGhlcndpc2Ugd2UgaGF2ZSB0aGUgaW5zdGFsbGVkIHZlcnNpb24gYW5kIHRoZSB1c2VyIHNwZWNpZmllZFxuICAgICAgLy8gaXQgb24gdGhlIGNvbW1hbmQgbGluZS5cbiAgICAgIGlmIChvcHRpb25zLmFsbCkge1xuICAgICAgICBsb2dnZXIud2FybihcbiAgICAgICAgICBgUGFja2FnZSAke0pTT04uc3RyaW5naWZ5KG5wbU5hbWUpfSBoYXMgYSBjdXN0b20gdmVyc2lvbjogYFxuICAgICAgICAgICsgYCR7SlNPTi5zdHJpbmdpZnkodmVyc2lvbil9LiBTa2lwcGluZy5gLFxuICAgICAgICApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBwYWNrYWdlcy5zZXQobnBtTmFtZSwgKG1heWJlVmVyc2lvbiB8fCAob3B0aW9ucy5uZXh0ID8gJ25leHQnIDogJ2xhdGVzdCcpKSBhcyBWZXJzaW9uUmFuZ2UpO1xuICB9XG5cbiAgcmV0dXJuIHBhY2thZ2VzO1xufVxuXG5cbmZ1bmN0aW9uIF9hZGRQYWNrYWdlR3JvdXAoXG4gIHBhY2thZ2VzOiBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+LFxuICBhbGxEZXBlbmRlbmNpZXM6IFJlYWRvbmx5TWFwPHN0cmluZywgc3RyaW5nPixcbiAgbnBtUGFja2FnZUpzb246IE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbixcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IHZvaWQge1xuICBjb25zdCBtYXliZVBhY2thZ2UgPSBwYWNrYWdlcy5nZXQobnBtUGFja2FnZUpzb24ubmFtZSk7XG4gIGlmICghbWF5YmVQYWNrYWdlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdmVyc2lvbiA9IG5wbVBhY2thZ2VKc29uWydkaXN0LXRhZ3MnXVttYXliZVBhY2thZ2VdIHx8IG1heWJlUGFja2FnZTtcbiAgaWYgKCFucG1QYWNrYWdlSnNvbi52ZXJzaW9uc1t2ZXJzaW9uXSkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBuZ1VwZGF0ZU1ldGFkYXRhID0gbnBtUGFja2FnZUpzb24udmVyc2lvbnNbdmVyc2lvbl1bJ25nLXVwZGF0ZSddO1xuICBpZiAoIW5nVXBkYXRlTWV0YWRhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBwYWNrYWdlR3JvdXAgPSBuZ1VwZGF0ZU1ldGFkYXRhWydwYWNrYWdlR3JvdXAnXTtcbiAgaWYgKCFwYWNrYWdlR3JvdXApIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFBcnJheS5pc0FycmF5KHBhY2thZ2VHcm91cCkgfHwgcGFja2FnZUdyb3VwLnNvbWUoeCA9PiB0eXBlb2YgeCAhPSAnc3RyaW5nJykpIHtcbiAgICBsb2dnZXIud2FybihgcGFja2FnZUdyb3VwIG1ldGFkYXRhIG9mIHBhY2thZ2UgJHtucG1QYWNrYWdlSnNvbi5uYW1lfSBpcyBtYWxmb3JtZWQuYCk7XG5cbiAgICByZXR1cm47XG4gIH1cblxuICBwYWNrYWdlR3JvdXBcbiAgICAuZmlsdGVyKG5hbWUgPT4gIXBhY2thZ2VzLmhhcyhuYW1lKSkgIC8vIERvbid0IG92ZXJyaWRlIG5hbWVzIGZyb20gdGhlIGNvbW1hbmQgbGluZS5cbiAgICAuZmlsdGVyKG5hbWUgPT4gYWxsRGVwZW5kZW5jaWVzLmhhcyhuYW1lKSkgIC8vIFJlbW92ZSBwYWNrYWdlcyB0aGF0IGFyZW4ndCBpbnN0YWxsZWQuXG4gICAgLmZvckVhY2gobmFtZSA9PiB7XG4gICAgcGFja2FnZXMuc2V0KG5hbWUsIG1heWJlUGFja2FnZSk7XG4gIH0pO1xufVxuXG4vKipcbiAqIEFkZCBwZWVyIGRlcGVuZGVuY2llcyBvZiBwYWNrYWdlcyBvbiB0aGUgY29tbWFuZCBsaW5lIHRvIHRoZSBsaXN0IG9mIHBhY2thZ2VzIHRvIHVwZGF0ZS5cbiAqIFdlIGRvbid0IGRvIHZlcmlmaWNhdGlvbiBvZiB0aGUgdmVyc2lvbnMgaGVyZSBhcyB0aGlzIHdpbGwgYmUgZG9uZSBieSBhIGxhdGVyIHN0ZXAgKGFuZCBjYW5cbiAqIGJlIGlnbm9yZWQgYnkgdGhlIC0tZm9yY2UgZmxhZykuXG4gKiBAcHJpdmF0ZVxuICovXG5mdW5jdGlvbiBfYWRkUGVlckRlcGVuZGVuY2llcyhcbiAgcGFja2FnZXM6IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4sXG4gIF9hbGxEZXBlbmRlbmNpZXM6IFJlYWRvbmx5TWFwPHN0cmluZywgc3RyaW5nPixcbiAgbnBtUGFja2FnZUpzb246IE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbixcbiAgX2xvZ2dlcjogbG9nZ2luZy5Mb2dnZXJBcGksXG4pOiB2b2lkIHtcbiAgY29uc3QgbWF5YmVQYWNrYWdlID0gcGFja2FnZXMuZ2V0KG5wbVBhY2thZ2VKc29uLm5hbWUpO1xuICBpZiAoIW1heWJlUGFja2FnZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHZlcnNpb24gPSBucG1QYWNrYWdlSnNvblsnZGlzdC10YWdzJ11bbWF5YmVQYWNrYWdlXSB8fCBtYXliZVBhY2thZ2U7XG4gIGlmICghbnBtUGFja2FnZUpzb24udmVyc2lvbnNbdmVyc2lvbl0pIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBwYWNrYWdlSnNvbiA9IG5wbVBhY2thZ2VKc29uLnZlcnNpb25zW3ZlcnNpb25dO1xuICBjb25zdCBlcnJvciA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgW3BlZXIsIHJhbmdlXSBvZiBPYmplY3QuZW50cmllcyhwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzIHx8IHt9KSkge1xuICAgIGlmICghcGFja2FnZXMuaGFzKHBlZXIpKSB7XG4gICAgICBwYWNrYWdlcy5zZXQocGVlciwgcmFuZ2UgYXMgVmVyc2lvblJhbmdlKTtcbiAgICB9XG4gIH1cblxuICBpZiAoZXJyb3IpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbignQW4gZXJyb3Igb2NjdXJlZCwgc2VlIGFib3ZlLicpO1xuICB9XG59XG5cblxuZnVuY3Rpb24gX2dldEFsbERlcGVuZGVuY2llcyh0cmVlOiBUcmVlKTogTWFwPHN0cmluZywgVmVyc2lvblJhbmdlPiB7XG4gIGNvbnN0IHBhY2thZ2VKc29uQ29udGVudCA9IHRyZWUucmVhZCgnL3BhY2thZ2UuanNvbicpO1xuICBpZiAoIXBhY2thZ2VKc29uQ29udGVudCkge1xuICAgIHRocm93IG5ldyBTY2hlbWF0aWNzRXhjZXB0aW9uKCdDb3VsZCBub3QgZmluZCBhIHBhY2thZ2UuanNvbi4gQXJlIHlvdSBpbiBhIE5vZGUgcHJvamVjdD8nKTtcbiAgfVxuXG4gIGxldCBwYWNrYWdlSnNvbjogSnNvblNjaGVtYUZvck5wbVBhY2thZ2VKc29uRmlsZXM7XG4gIHRyeSB7XG4gICAgcGFja2FnZUpzb24gPSBKU09OLnBhcnNlKHBhY2thZ2VKc29uQ29udGVudC50b1N0cmluZygpKSBhcyBKc29uU2NoZW1hRm9yTnBtUGFja2FnZUpzb25GaWxlcztcbiAgfSBjYXRjaCAoZSkge1xuICAgIHRocm93IG5ldyBTY2hlbWF0aWNzRXhjZXB0aW9uKCdwYWNrYWdlLmpzb24gY291bGQgbm90IGJlIHBhcnNlZDogJyArIGUubWVzc2FnZSk7XG4gIH1cblxuICByZXR1cm4gbmV3IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4oW1xuICAgIC4uLk9iamVjdC5lbnRyaWVzKHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXMgfHwge30pLFxuICAgIC4uLk9iamVjdC5lbnRyaWVzKHBhY2thZ2VKc29uLmRldkRlcGVuZGVuY2llcyB8fCB7fSksXG4gICAgLi4uT2JqZWN0LmVudHJpZXMocGFja2FnZUpzb24uZGVwZW5kZW5jaWVzIHx8IHt9KSxcbiAgXSBhcyBbc3RyaW5nLCBWZXJzaW9uUmFuZ2VdW10pO1xufVxuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbihvcHRpb25zOiBVcGRhdGVTY2hlbWEpOiBSdWxlIHtcbiAgaWYgKCFvcHRpb25zLnBhY2thZ2VzKSB7XG4gICAgLy8gV2UgY2Fubm90IGp1c3QgcmV0dXJuIHRoaXMgYmVjYXVzZSB3ZSBuZWVkIHRvIGZldGNoIHRoZSBwYWNrYWdlcyBmcm9tIE5QTSBzdGlsbCBmb3IgdGhlXG4gICAgLy8gaGVscC9ndWlkZSB0byBzaG93LlxuICAgIG9wdGlvbnMucGFja2FnZXMgPSBbXTtcbiAgfSBlbHNlIGlmICh0eXBlb2Ygb3B0aW9ucy5wYWNrYWdlcyA9PSAnc3RyaW5nJykge1xuICAgIC8vIElmIGEgc3RyaW5nLCB0aGVuIHdlIHNob3VsZCBzcGxpdCBpdCBhbmQgbWFrZSBpdCBhbiBhcnJheS5cbiAgICBvcHRpb25zLnBhY2thZ2VzID0gb3B0aW9ucy5wYWNrYWdlcy5zcGxpdCgvLC9nKTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLm1pZ3JhdGVPbmx5ICYmIG9wdGlvbnMuZnJvbSkge1xuICAgIGlmIChvcHRpb25zLnBhY2thZ2VzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oJy0tZnJvbSByZXF1aXJlcyB0aGF0IG9ubHkgYSBzaW5nbGUgcGFja2FnZSBiZSBwYXNzZWQuJyk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuICh0cmVlOiBUcmVlLCBjb250ZXh0OiBTY2hlbWF0aWNDb250ZXh0KSA9PiB7XG4gICAgY29uc3QgbG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgY29uc3QgYWxsRGVwZW5kZW5jaWVzID0gX2dldEFsbERlcGVuZGVuY2llcyh0cmVlKTtcbiAgICBjb25zdCBwYWNrYWdlcyA9IF9idWlsZFBhY2thZ2VMaXN0KG9wdGlvbnMsIGFsbERlcGVuZGVuY2llcywgbG9nZ2VyKTtcblxuICAgIHJldHVybiBvYnNlcnZhYmxlRnJvbShbLi4uYWxsRGVwZW5kZW5jaWVzLmtleXMoKV0pLnBpcGUoXG4gICAgICAvLyBHcmFiIGFsbCBwYWNrYWdlLmpzb24gZnJvbSB0aGUgbnBtIHJlcG9zaXRvcnkuIFRoaXMgcmVxdWlyZXMgYSBsb3Qgb2YgSFRUUCBjYWxscyBzbyB3ZVxuICAgICAgLy8gdHJ5IHRvIHBhcmFsbGVsaXplIGFzIG1hbnkgYXMgcG9zc2libGUuXG4gICAgICBtZXJnZU1hcChkZXBOYW1lID0+IGdldE5wbVBhY2thZ2VKc29uKGRlcE5hbWUsIGxvZ2dlcikpLFxuXG4gICAgICAvLyBCdWlsZCBhIG1hcCBvZiBhbGwgZGVwZW5kZW5jaWVzIGFuZCB0aGVpciBwYWNrYWdlSnNvbi5cbiAgICAgIHJlZHVjZTxOcG1SZXBvc2l0b3J5UGFja2FnZUpzb24sIE1hcDxzdHJpbmcsIE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbj4+KFxuICAgICAgICAoYWNjLCBucG1QYWNrYWdlSnNvbikgPT4gYWNjLnNldChucG1QYWNrYWdlSnNvbi5uYW1lLCBucG1QYWNrYWdlSnNvbiksXG4gICAgICAgIG5ldyBNYXA8c3RyaW5nLCBOcG1SZXBvc2l0b3J5UGFja2FnZUpzb24+KCksXG4gICAgICApLFxuXG4gICAgICBtYXAobnBtUGFja2FnZUpzb25NYXAgPT4ge1xuICAgICAgICAvLyBBdWdtZW50IHRoZSBjb21tYW5kIGxpbmUgcGFja2FnZSBsaXN0IHdpdGggcGFja2FnZUdyb3VwcyBhbmQgZm9yd2FyZCBwZWVyIGRlcGVuZGVuY2llcy5cbiAgICAgICAgbnBtUGFja2FnZUpzb25NYXAuZm9yRWFjaCgobnBtUGFja2FnZUpzb24pID0+IHtcbiAgICAgICAgICBfYWRkUGFja2FnZUdyb3VwKHBhY2thZ2VzLCBhbGxEZXBlbmRlbmNpZXMsIG5wbVBhY2thZ2VKc29uLCBsb2dnZXIpO1xuICAgICAgICAgIF9hZGRQZWVyRGVwZW5kZW5jaWVzKHBhY2thZ2VzLCBhbGxEZXBlbmRlbmNpZXMsIG5wbVBhY2thZ2VKc29uLCBsb2dnZXIpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBCdWlsZCB0aGUgUGFja2FnZUluZm8gZm9yIGVhY2ggbW9kdWxlLlxuICAgICAgICBjb25zdCBwYWNrYWdlSW5mb01hcCA9IG5ldyBNYXA8c3RyaW5nLCBQYWNrYWdlSW5mbz4oKTtcbiAgICAgICAgbnBtUGFja2FnZUpzb25NYXAuZm9yRWFjaCgobnBtUGFja2FnZUpzb24pID0+IHtcbiAgICAgICAgICBwYWNrYWdlSW5mb01hcC5zZXQoXG4gICAgICAgICAgICBucG1QYWNrYWdlSnNvbi5uYW1lLFxuICAgICAgICAgICAgX2J1aWxkUGFja2FnZUluZm8odHJlZSwgcGFja2FnZXMsIGFsbERlcGVuZGVuY2llcywgbnBtUGFja2FnZUpzb24sIGxvZ2dlciksXG4gICAgICAgICAgKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBhY2thZ2VJbmZvTWFwO1xuICAgICAgfSksXG5cbiAgICAgIHN3aXRjaE1hcChpbmZvTWFwID0+IHtcbiAgICAgICAgLy8gTm93IHRoYXQgd2UgaGF2ZSBhbGwgdGhlIGluZm9ybWF0aW9uLCBjaGVjayB0aGUgZmxhZ3MuXG4gICAgICAgIGlmIChwYWNrYWdlcy5zaXplID4gMCkge1xuICAgICAgICAgIGlmIChvcHRpb25zLm1pZ3JhdGVPbmx5ICYmIG9wdGlvbnMuZnJvbSAmJiBvcHRpb25zLnBhY2thZ2VzKSB7XG4gICAgICAgICAgICByZXR1cm4gX21pZ3JhdGVPbmx5KFxuICAgICAgICAgICAgICBpbmZvTWFwLmdldChvcHRpb25zLnBhY2thZ2VzWzBdKSxcbiAgICAgICAgICAgICAgY29udGV4dCxcbiAgICAgICAgICAgICAgb3B0aW9ucy5mcm9tLFxuICAgICAgICAgICAgICBvcHRpb25zLnRvLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBzdWJsb2cgPSBuZXcgbG9nZ2luZy5MZXZlbENhcExvZ2dlcihcbiAgICAgICAgICAgICd2YWxpZGF0aW9uJyxcbiAgICAgICAgICAgIGxvZ2dlci5jcmVhdGVDaGlsZCgnJyksXG4gICAgICAgICAgICAnd2FybicsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBfdmFsaWRhdGVVcGRhdGVQYWNrYWdlcyhpbmZvTWFwLCBvcHRpb25zLmZvcmNlLCBzdWJsb2cpO1xuXG4gICAgICAgICAgcmV0dXJuIF9wZXJmb3JtVXBkYXRlKHRyZWUsIGNvbnRleHQsIGluZm9NYXAsIGxvZ2dlciwgb3B0aW9ucy5taWdyYXRlT25seSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIF91c2FnZU1lc3NhZ2Uob3B0aW9ucywgaW5mb01hcCwgbG9nZ2VyKTtcbiAgICAgICAgfVxuICAgICAgfSksXG5cbiAgICAgIHN3aXRjaE1hcCgoKSA9PiBvZih0cmVlKSksXG4gICAgKTtcbiAgfTtcbn1cbiJdfQ==