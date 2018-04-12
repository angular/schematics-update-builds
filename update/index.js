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
        operators_1.mergeMap(depName => npm_1.getNpmPackageJson(depName, options.registry, logger)), 
        // Build a map of all dependencies and their packageJson.
        operators_1.reduce((acc, npmPackageJson) => {
            // If the package was not found on the registry. It could be private, so we will just
            // ignore. If the package was part of the list, we will error out, but will simply ignore
            // if it's either not requested (so just part of package.json. silently) or if it's a
            // `--all` situation. There is an edge case here where a public package peer depends on a
            // private one, but it's rare enough.
            if (!npmPackageJson.name) {
                if (packages.has(npmPackageJson.requestedName)) {
                    if (options.all) {
                        logger.warn(`Package ${JSON.stringify(npmPackageJson.requestedName)} was not `
                            + 'found on the registry. Skipping.');
                    }
                    else {
                        throw new schematics_1.SchematicsException(`Package ${JSON.stringify(npmPackageJson.requestedName)} was not found on the `
                            + 'registry. Cannot continue as this may be an error.');
                    }
                }
            }
            else {
                acc.set(npmPackageJson.name, npmPackageJson);
            }
            return acc;
        }, new Map()), operators_1.map(npmPackageJsonMap => {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiLi8iLCJzb3VyY2VzIjpbInBhY2thZ2VzL3NjaGVtYXRpY3MvdXBkYXRlL3VwZGF0ZS9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBOzs7Ozs7R0FNRztBQUNILCtDQUErQztBQUMvQywyREFHb0M7QUFDcEMsNERBQTRGO0FBQzVGLCtCQUE4RDtBQUM5RCw4Q0FBa0U7QUFDbEUsaUNBQWlDO0FBQ2pDLCtCQUEwQztBQTJCMUMsMENBQ0UsSUFBWSxFQUNaLE9BQWlDLEVBQ2pDLEtBQStCLEVBQy9CLE1BQXlCO0lBRXpCLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbEQsTUFBTSxDQUFDLEtBQUssQ0FBQyx5QkFBeUIsSUFBSSxLQUFLLENBQUMsQ0FBQztRQUNqRCxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3hDLEVBQUUsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQztZQUNuQixNQUFNLENBQUMsS0FBSyxDQUFDO2dCQUNYLFdBQVcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsbUNBQW1DO2dCQUNsRSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsR0FBRzthQUN0RCxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBRWIsTUFBTSxDQUFDLElBQUksQ0FBQztRQUNkLENBQUM7UUFFRCxNQUFNLFdBQVcsR0FBRyxhQUFhLENBQUMsTUFBTSxJQUFJLGFBQWEsQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLE9BQU87WUFDbEYsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLE9B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QUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUM3RSxDQUFDO1lBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ04sTUFBTSxDQUFDLGFBQWEsQ0FBQyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQ2pELENBQUM7UUFDSCxDQUFDLENBQUMsRUFFRixxQkFBUyxDQUFDLEdBQUcsRUFBRSxDQUFDLFNBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUMxQixDQUFDO0lBQ0osQ0FBQyxDQUFDO0FBQ0osQ0FBQztBQXJHRCw0QkFxR0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEBsaWNlbnNlXG4gKiBDb3B5cmlnaHQgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cbiAqXG4gKiBVc2Ugb2YgdGhpcyBzb3VyY2UgY29kZSBpcyBnb3Zlcm5lZCBieSBhbiBNSVQtc3R5bGUgbGljZW5zZSB0aGF0IGNhbiBiZVxuICogZm91bmQgaW4gdGhlIExJQ0VOU0UgZmlsZSBhdCBodHRwczovL2FuZ3VsYXIuaW8vbGljZW5zZVxuICovXG5pbXBvcnQgeyBsb2dnaW5nIH0gZnJvbSAnQGFuZ3VsYXItZGV2a2l0L2NvcmUnO1xuaW1wb3J0IHtcbiAgUnVsZSwgU2NoZW1hdGljQ29udGV4dCwgU2NoZW1hdGljc0V4Y2VwdGlvbiwgVGFza0lkLFxuICBUcmVlLFxufSBmcm9tICdAYW5ndWxhci1kZXZraXQvc2NoZW1hdGljcyc7XG5pbXBvcnQgeyBOb2RlUGFja2FnZUluc3RhbGxUYXNrLCBSdW5TY2hlbWF0aWNUYXNrIH0gZnJvbSAnQGFuZ3VsYXItZGV2a2l0L3NjaGVtYXRpY3MvdGFza3MnO1xuaW1wb3J0IHsgT2JzZXJ2YWJsZSwgZnJvbSBhcyBvYnNlcnZhYmxlRnJvbSwgb2YgfSBmcm9tICdyeGpzJztcbmltcG9ydCB7IG1hcCwgbWVyZ2VNYXAsIHJlZHVjZSwgc3dpdGNoTWFwIH0gZnJvbSAncnhqcy9vcGVyYXRvcnMnO1xuaW1wb3J0ICogYXMgc2VtdmVyIGZyb20gJ3NlbXZlcic7XG5pbXBvcnQgeyBnZXROcG1QYWNrYWdlSnNvbiB9IGZyb20gJy4vbnBtJztcbmltcG9ydCB7IE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbiB9IGZyb20gJy4vbnBtLXBhY2thZ2UtanNvbic7XG5pbXBvcnQgeyBKc29uU2NoZW1hRm9yTnBtUGFja2FnZUpzb25GaWxlcyB9IGZyb20gJy4vcGFja2FnZS1qc29uJztcbmltcG9ydCB7IFVwZGF0ZVNjaGVtYSB9IGZyb20gJy4vc2NoZW1hJztcblxudHlwZSBWZXJzaW9uUmFuZ2UgPSBzdHJpbmcgJiB7IF9fOiB2b2lkOyB9O1xuXG5pbnRlcmZhY2UgUGFja2FnZVZlcnNpb25JbmZvIHtcbiAgdmVyc2lvbjogVmVyc2lvblJhbmdlO1xuICBwYWNrYWdlSnNvbjogSnNvblNjaGVtYUZvck5wbVBhY2thZ2VKc29uRmlsZXM7XG4gIHVwZGF0ZU1ldGFkYXRhOiBVcGRhdGVNZXRhZGF0YTtcbn1cblxuaW50ZXJmYWNlIFBhY2thZ2VJbmZvIHtcbiAgbmFtZTogc3RyaW5nO1xuICBucG1QYWNrYWdlSnNvbjogTnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uO1xuICBpbnN0YWxsZWQ6IFBhY2thZ2VWZXJzaW9uSW5mbztcbiAgdGFyZ2V0PzogUGFja2FnZVZlcnNpb25JbmZvO1xuICBwYWNrYWdlSnNvblJhbmdlOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBVcGRhdGVNZXRhZGF0YSB7XG4gIHBhY2thZ2VHcm91cDogc3RyaW5nW107XG4gIHJlcXVpcmVtZW50czogeyBbcGFja2FnZU5hbWU6IHN0cmluZ106IHN0cmluZyB9O1xuICBtaWdyYXRpb25zPzogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBfdmFsaWRhdGVGb3J3YXJkUGVlckRlcGVuZGVuY2llcyhcbiAgbmFtZTogc3RyaW5nLFxuICBpbmZvTWFwOiBNYXA8c3RyaW5nLCBQYWNrYWdlSW5mbz4sXG4gIHBlZXJzOiB7W25hbWU6IHN0cmluZ106IHN0cmluZ30sXG4gIGxvZ2dlcjogbG9nZ2luZy5Mb2dnZXJBcGksXG4pOiBib29sZWFuIHtcbiAgZm9yIChjb25zdCBbcGVlciwgcmFuZ2VdIG9mIE9iamVjdC5lbnRyaWVzKHBlZXJzKSkge1xuICAgIGxvZ2dlci5kZWJ1ZyhgQ2hlY2tpbmcgZm9yd2FyZCBwZWVyICR7cGVlcn0uLi5gKTtcbiAgICBjb25zdCBtYXliZVBlZXJJbmZvID0gaW5mb01hcC5nZXQocGVlcik7XG4gICAgaWYgKCFtYXliZVBlZXJJbmZvKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoW1xuICAgICAgICBgUGFja2FnZSAke0pTT04uc3RyaW5naWZ5KG5hbWUpfSBoYXMgYSBtaXNzaW5nIHBlZXIgZGVwZW5kZW5jeSBvZmAsXG4gICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHBlZXIpfSBAICR7SlNPTi5zdHJpbmdpZnkocmFuZ2UpfS5gLFxuICAgICAgXS5qb2luKCcgJykpO1xuXG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBjb25zdCBwZWVyVmVyc2lvbiA9IG1heWJlUGVlckluZm8udGFyZ2V0ICYmIG1heWJlUGVlckluZm8udGFyZ2V0LnBhY2thZ2VKc29uLnZlcnNpb25cbiAgICAgID8gbWF5YmVQZWVySW5mby50YXJnZXQucGFja2FnZUpzb24udmVyc2lvblxuICAgICAgOiBtYXliZVBlZXJJbmZvLmluc3RhbGxlZC52ZXJzaW9uO1xuXG4gICAgbG9nZ2VyLmRlYnVnKGAgIFJhbmdlIGludGVyc2VjdHMoJHtyYW5nZX0sICR7cGVlclZlcnNpb259KS4uLmApO1xuICAgIGlmICghc2VtdmVyLnNhdGlzZmllcyhwZWVyVmVyc2lvbiwgcmFuZ2UpKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoW1xuICAgICAgICBgUGFja2FnZSAke0pTT04uc3RyaW5naWZ5KG5hbWUpfSBoYXMgYW4gaW5jb21wYXRpYmxlIHBlZXIgZGVwZW5kZW5jeSB0b2AsXG4gICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHBlZXIpfSAocmVxdWlyZXMgJHtKU09OLnN0cmluZ2lmeShyYW5nZSl9LGAsXG4gICAgICAgIGB3b3VsZCBpbnN0YWxsICR7SlNPTi5zdHJpbmdpZnkocGVlclZlcnNpb24pfSlgLFxuICAgICAgXS5qb2luKCcgJykpO1xuXG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG5cblxuZnVuY3Rpb24gX3ZhbGlkYXRlUmV2ZXJzZVBlZXJEZXBlbmRlbmNpZXMoXG4gIG5hbWU6IHN0cmluZyxcbiAgdmVyc2lvbjogc3RyaW5nLFxuICBpbmZvTWFwOiBNYXA8c3RyaW5nLCBQYWNrYWdlSW5mbz4sXG4gIGxvZ2dlcjogbG9nZ2luZy5Mb2dnZXJBcGksXG4pIHtcbiAgZm9yIChjb25zdCBbaW5zdGFsbGVkLCBpbnN0YWxsZWRJbmZvXSBvZiBpbmZvTWFwLmVudHJpZXMoKSkge1xuICAgIGNvbnN0IGluc3RhbGxlZExvZ2dlciA9IGxvZ2dlci5jcmVhdGVDaGlsZChpbnN0YWxsZWQpO1xuICAgIGluc3RhbGxlZExvZ2dlci5kZWJ1ZyhgJHtpbnN0YWxsZWR9Li4uYCk7XG4gICAgY29uc3QgcGVlcnMgPSAoaW5zdGFsbGVkSW5mby50YXJnZXQgfHwgaW5zdGFsbGVkSW5mby5pbnN0YWxsZWQpLnBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXM7XG5cbiAgICBmb3IgKGNvbnN0IFtwZWVyLCByYW5nZV0gb2YgT2JqZWN0LmVudHJpZXMocGVlcnMgfHwge30pKSB7XG4gICAgICBpZiAocGVlciAhPSBuYW1lKSB7XG4gICAgICAgIC8vIE9ubHkgY2hlY2sgcGVlcnMgdG8gdGhlIHBhY2thZ2VzIHdlJ3JlIHVwZGF0aW5nLiBXZSBkb24ndCBjYXJlIGFib3V0IHBlZXJzXG4gICAgICAgIC8vIHRoYXQgYXJlIHVubWV0IGJ1dCB3ZSBoYXZlIG5vIGVmZmVjdCBvbi5cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmICghc2VtdmVyLnNhdGlzZmllcyh2ZXJzaW9uLCByYW5nZSkpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKFtcbiAgICAgICAgICBgUGFja2FnZSAke0pTT04uc3RyaW5naWZ5KGluc3RhbGxlZCl9IGhhcyBhbiBpbmNvbXBhdGlibGUgcGVlciBkZXBlbmRlbmN5IHRvYCxcbiAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeShuYW1lKX0gKHJlcXVpcmVzICR7SlNPTi5zdHJpbmdpZnkocmFuZ2UpfSxgLFxuICAgICAgICAgIGB3b3VsZCBpbnN0YWxsICR7SlNPTi5zdHJpbmdpZnkodmVyc2lvbil9KS5gLFxuICAgICAgICBdLmpvaW4oJyAnKSk7XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBfdmFsaWRhdGVVcGRhdGVQYWNrYWdlcyhcbiAgaW5mb01hcDogTWFwPHN0cmluZywgUGFja2FnZUluZm8+LFxuICBmb3JjZTogYm9vbGVhbixcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IHZvaWQge1xuICBsb2dnZXIuZGVidWcoJ1VwZGF0aW5nIHRoZSBmb2xsb3dpbmcgcGFja2FnZXM6Jyk7XG4gIGluZm9NYXAuZm9yRWFjaChpbmZvID0+IHtcbiAgICBpZiAoaW5mby50YXJnZXQpIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhgICAke2luZm8ubmFtZX0gPT4gJHtpbmZvLnRhcmdldC52ZXJzaW9ufWApO1xuICAgIH1cbiAgfSk7XG5cbiAgbGV0IHBlZXJFcnJvcnMgPSBmYWxzZTtcbiAgaW5mb01hcC5mb3JFYWNoKGluZm8gPT4ge1xuICAgIGNvbnN0IHtuYW1lLCB0YXJnZXR9ID0gaW5mbztcbiAgICBpZiAoIXRhcmdldCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHBrZ0xvZ2dlciA9IGxvZ2dlci5jcmVhdGVDaGlsZChuYW1lKTtcbiAgICBsb2dnZXIuZGVidWcoYCR7bmFtZX0uLi5gKTtcblxuICAgIGNvbnN0IHBlZXJzID0gdGFyZ2V0LnBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXMgfHwge307XG4gICAgcGVlckVycm9ycyA9IF92YWxpZGF0ZUZvcndhcmRQZWVyRGVwZW5kZW5jaWVzKG5hbWUsIGluZm9NYXAsIHBlZXJzLCBwa2dMb2dnZXIpIHx8IHBlZXJFcnJvcnM7XG4gICAgcGVlckVycm9yc1xuICAgICAgPSBfdmFsaWRhdGVSZXZlcnNlUGVlckRlcGVuZGVuY2llcyhuYW1lLCB0YXJnZXQudmVyc2lvbiwgaW5mb01hcCwgcGtnTG9nZ2VyKVxuICAgICAgfHwgcGVlckVycm9ycztcbiAgfSk7XG5cbiAgaWYgKCFmb3JjZSAmJiBwZWVyRXJyb3JzKSB7XG4gICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oYEluY29tcGF0aWJsZSBwZWVyIGRlcGVuZGVuY2llcyBmb3VuZC4gU2VlIGFib3ZlLmApO1xuICB9XG59XG5cblxuZnVuY3Rpb24gX3BlcmZvcm1VcGRhdGUoXG4gIHRyZWU6IFRyZWUsXG4gIGNvbnRleHQ6IFNjaGVtYXRpY0NvbnRleHQsXG4gIGluZm9NYXA6IE1hcDxzdHJpbmcsIFBhY2thZ2VJbmZvPixcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbiAgbWlncmF0ZU9ubHk6IGJvb2xlYW4sXG4pOiBPYnNlcnZhYmxlPHZvaWQ+IHtcbiAgY29uc3QgcGFja2FnZUpzb25Db250ZW50ID0gdHJlZS5yZWFkKCcvcGFja2FnZS5qc29uJyk7XG4gIGlmICghcGFja2FnZUpzb25Db250ZW50KSB7XG4gICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oJ0NvdWxkIG5vdCBmaW5kIGEgcGFja2FnZS5qc29uLiBBcmUgeW91IGluIGEgTm9kZSBwcm9qZWN0PycpO1xuICB9XG5cbiAgbGV0IHBhY2thZ2VKc29uOiBKc29uU2NoZW1hRm9yTnBtUGFja2FnZUpzb25GaWxlcztcbiAgdHJ5IHtcbiAgICBwYWNrYWdlSnNvbiA9IEpTT04ucGFyc2UocGFja2FnZUpzb25Db250ZW50LnRvU3RyaW5nKCkpIGFzIEpzb25TY2hlbWFGb3JOcG1QYWNrYWdlSnNvbkZpbGVzO1xuICB9IGNhdGNoIChlKSB7XG4gICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oJ3BhY2thZ2UuanNvbiBjb3VsZCBub3QgYmUgcGFyc2VkOiAnICsgZS5tZXNzYWdlKTtcbiAgfVxuXG4gIGNvbnN0IHRvSW5zdGFsbCA9IFsuLi5pbmZvTWFwLnZhbHVlcygpXVxuICAgICAgLm1hcCh4ID0+IFt4Lm5hbWUsIHgudGFyZ2V0LCB4Lmluc3RhbGxlZF0pXG4gICAgICAvLyB0c2xpbnQ6ZGlzYWJsZS1uZXh0LWxpbmU6bm9uLW51bGwtb3BlcmF0b3JcbiAgICAgIC5maWx0ZXIoKFtuYW1lLCB0YXJnZXQsIGluc3RhbGxlZF0pID0+IHtcbiAgICAgICAgcmV0dXJuICEhbmFtZSAmJiAhIXRhcmdldCAmJiAhIWluc3RhbGxlZDtcbiAgICAgIH0pIGFzIFtzdHJpbmcsIFBhY2thZ2VWZXJzaW9uSW5mbywgUGFja2FnZVZlcnNpb25JbmZvXVtdO1xuXG4gIHRvSW5zdGFsbC5mb3JFYWNoKChbbmFtZSwgdGFyZ2V0LCBpbnN0YWxsZWRdKSA9PiB7XG4gICAgbG9nZ2VyLmluZm8oXG4gICAgICBgVXBkYXRpbmcgcGFja2FnZS5qc29uIHdpdGggZGVwZW5kZW5jeSAke25hbWV9IGBcbiAgICAgICsgYEAgJHtKU09OLnN0cmluZ2lmeSh0YXJnZXQudmVyc2lvbil9ICh3YXMgJHtKU09OLnN0cmluZ2lmeShpbnN0YWxsZWQudmVyc2lvbil9KS4uLmAsXG4gICAgKTtcblxuICAgIGlmIChwYWNrYWdlSnNvbi5kZXBlbmRlbmNpZXMgJiYgcGFja2FnZUpzb24uZGVwZW5kZW5jaWVzW25hbWVdKSB7XG4gICAgICBwYWNrYWdlSnNvbi5kZXBlbmRlbmNpZXNbbmFtZV0gPSB0YXJnZXQudmVyc2lvbjtcblxuICAgICAgaWYgKHBhY2thZ2VKc29uLmRldkRlcGVuZGVuY2llcyAmJiBwYWNrYWdlSnNvbi5kZXZEZXBlbmRlbmNpZXNbbmFtZV0pIHtcbiAgICAgICAgZGVsZXRlIHBhY2thZ2VKc29uLmRldkRlcGVuZGVuY2llc1tuYW1lXTtcbiAgICAgIH1cbiAgICAgIGlmIChwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzICYmIHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXNbbmFtZV0pIHtcbiAgICAgICAgZGVsZXRlIHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXNbbmFtZV07XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChwYWNrYWdlSnNvbi5kZXZEZXBlbmRlbmNpZXMgJiYgcGFja2FnZUpzb24uZGV2RGVwZW5kZW5jaWVzW25hbWVdKSB7XG4gICAgICBwYWNrYWdlSnNvbi5kZXZEZXBlbmRlbmNpZXNbbmFtZV0gPSB0YXJnZXQudmVyc2lvbjtcblxuICAgICAgaWYgKHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXMgJiYgcGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llc1tuYW1lXSkge1xuICAgICAgICBkZWxldGUgcGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llc1tuYW1lXTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXMgJiYgcGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llc1tuYW1lXSkge1xuICAgICAgcGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llc1tuYW1lXSA9IHRhcmdldC52ZXJzaW9uO1xuICAgIH0gZWxzZSB7XG4gICAgICBsb2dnZXIud2FybihgUGFja2FnZSAke25hbWV9IHdhcyBub3QgZm91bmQgaW4gZGVwZW5kZW5jaWVzLmApO1xuICAgIH1cbiAgfSk7XG5cbiAgY29uc3QgbmV3Q29udGVudCA9IEpTT04uc3RyaW5naWZ5KHBhY2thZ2VKc29uLCBudWxsLCAyKTtcbiAgaWYgKHBhY2thZ2VKc29uQ29udGVudC50b1N0cmluZygpICE9IG5ld0NvbnRlbnQgfHwgbWlncmF0ZU9ubHkpIHtcbiAgICBsZXQgaW5zdGFsbFRhc2s6IFRhc2tJZFtdID0gW107XG4gICAgaWYgKCFtaWdyYXRlT25seSkge1xuICAgICAgLy8gSWYgc29tZXRoaW5nIGNoYW5nZWQsIGFsc28gaG9vayB1cCB0aGUgdGFzay5cbiAgICAgIHRyZWUub3ZlcndyaXRlKCcvcGFja2FnZS5qc29uJywgSlNPTi5zdHJpbmdpZnkocGFja2FnZUpzb24sIG51bGwsIDIpKTtcbiAgICAgIGluc3RhbGxUYXNrID0gW2NvbnRleHQuYWRkVGFzayhuZXcgTm9kZVBhY2thZ2VJbnN0YWxsVGFzaygpKV07XG4gICAgfVxuXG4gICAgLy8gUnVuIHRoZSBtaWdyYXRlIHNjaGVtYXRpY3Mgd2l0aCB0aGUgbGlzdCBvZiBwYWNrYWdlcyB0byB1c2UuIFRoZSBjb2xsZWN0aW9uIGNvbnRhaW5zXG4gICAgLy8gdmVyc2lvbiBpbmZvcm1hdGlvbiBhbmQgd2UgbmVlZCB0byBkbyB0aGlzIHBvc3QgaW5zdGFsbGF0aW9uLiBQbGVhc2Ugbm90ZSB0aGF0IHRoZVxuICAgIC8vIG1pZ3JhdGlvbiBDT1VMRCBmYWlsIGFuZCBsZWF2ZSBzaWRlIGVmZmVjdHMgb24gZGlzay5cbiAgICAvLyBSdW4gdGhlIHNjaGVtYXRpY3MgdGFzayBvZiB0aG9zZSBwYWNrYWdlcy5cbiAgICB0b0luc3RhbGwuZm9yRWFjaCgoW25hbWUsIHRhcmdldCwgaW5zdGFsbGVkXSkgPT4ge1xuICAgICAgaWYgKCF0YXJnZXQudXBkYXRlTWV0YWRhdGEubWlncmF0aW9ucykge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGNvbGxlY3Rpb24gPSAoXG4gICAgICAgIHRhcmdldC51cGRhdGVNZXRhZGF0YS5taWdyYXRpb25zLm1hdGNoKC9eWy4vXS8pXG4gICAgICAgID8gbmFtZSArICcvJ1xuICAgICAgICA6ICcnXG4gICAgICApICsgdGFyZ2V0LnVwZGF0ZU1ldGFkYXRhLm1pZ3JhdGlvbnM7XG5cbiAgICAgIGNvbnRleHQuYWRkVGFzayhuZXcgUnVuU2NoZW1hdGljVGFzaygnQHNjaGVtYXRpY3MvdXBkYXRlJywgJ21pZ3JhdGUnLCB7XG4gICAgICAgICAgcGFja2FnZTogbmFtZSxcbiAgICAgICAgICBjb2xsZWN0aW9uLFxuICAgICAgICAgIGZyb206IGluc3RhbGxlZC52ZXJzaW9uLFxuICAgICAgICAgIHRvOiB0YXJnZXQudmVyc2lvbixcbiAgICAgICAgfSksXG4gICAgICAgIGluc3RhbGxUYXNrLFxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBvZjx2b2lkPih1bmRlZmluZWQpO1xufVxuXG5mdW5jdGlvbiBfbWlncmF0ZU9ubHkoXG4gIGluZm86IFBhY2thZ2VJbmZvIHwgdW5kZWZpbmVkLFxuICBjb250ZXh0OiBTY2hlbWF0aWNDb250ZXh0LFxuICBmcm9tOiBzdHJpbmcsXG4gIHRvPzogc3RyaW5nLFxuKSB7XG4gIGlmICghaW5mbykge1xuICAgIHJldHVybiBvZjx2b2lkPigpO1xuICB9XG5cbiAgY29uc3QgdGFyZ2V0ID0gaW5mby5pbnN0YWxsZWQ7XG4gIGlmICghdGFyZ2V0IHx8ICF0YXJnZXQudXBkYXRlTWV0YWRhdGEubWlncmF0aW9ucykge1xuICAgIHJldHVybiBvZjx2b2lkPih1bmRlZmluZWQpO1xuICB9XG5cbiAgY29uc3QgY29sbGVjdGlvbiA9IChcbiAgICB0YXJnZXQudXBkYXRlTWV0YWRhdGEubWlncmF0aW9ucy5tYXRjaCgvXlsuL10vKVxuICAgICAgPyBpbmZvLm5hbWUgKyAnLydcbiAgICAgIDogJydcbiAgKSArIHRhcmdldC51cGRhdGVNZXRhZGF0YS5taWdyYXRpb25zO1xuXG4gIGNvbnRleHQuYWRkVGFzayhuZXcgUnVuU2NoZW1hdGljVGFzaygnQHNjaGVtYXRpY3MvdXBkYXRlJywgJ21pZ3JhdGUnLCB7XG4gICAgICBwYWNrYWdlOiBpbmZvLm5hbWUsXG4gICAgICBjb2xsZWN0aW9uLFxuICAgICAgZnJvbTogZnJvbSxcbiAgICAgIHRvOiB0byB8fCB0YXJnZXQudmVyc2lvbixcbiAgICB9KSxcbiAgKTtcblxuICByZXR1cm4gb2Y8dm9pZD4odW5kZWZpbmVkKTtcbn1cblxuZnVuY3Rpb24gX2dldFVwZGF0ZU1ldGFkYXRhKFxuICBwYWNrYWdlSnNvbjogSnNvblNjaGVtYUZvck5wbVBhY2thZ2VKc29uRmlsZXMsXG4gIGxvZ2dlcjogbG9nZ2luZy5Mb2dnZXJBcGksXG4pOiBVcGRhdGVNZXRhZGF0YSB7XG4gIGNvbnN0IG1ldGFkYXRhID0gcGFja2FnZUpzb25bJ25nLXVwZGF0ZSddO1xuXG4gIGNvbnN0IHJlc3VsdDogVXBkYXRlTWV0YWRhdGEgPSB7XG4gICAgcGFja2FnZUdyb3VwOiBbXSxcbiAgICByZXF1aXJlbWVudHM6IHt9LFxuICB9O1xuXG4gIGlmICghbWV0YWRhdGEgfHwgdHlwZW9mIG1ldGFkYXRhICE9ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkobWV0YWRhdGEpKSB7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIGlmIChtZXRhZGF0YVsncGFja2FnZUdyb3VwJ10pIHtcbiAgICBjb25zdCBwYWNrYWdlR3JvdXAgPSBtZXRhZGF0YVsncGFja2FnZUdyb3VwJ107XG4gICAgLy8gVmVyaWZ5IHRoYXQgcGFja2FnZUdyb3VwIGlzIGFuIGFycmF5IG9mIHN0cmluZ3MuIFRoaXMgaXMgbm90IGFuIGVycm9yIGJ1dCB3ZSBzdGlsbCB3YXJuXG4gICAgLy8gdGhlIHVzZXIgYW5kIGlnbm9yZSB0aGUgcGFja2FnZUdyb3VwIGtleXMuXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHBhY2thZ2VHcm91cCkgfHwgcGFja2FnZUdyb3VwLnNvbWUoeCA9PiB0eXBlb2YgeCAhPSAnc3RyaW5nJykpIHtcbiAgICAgIGxvZ2dlci53YXJuKFxuICAgICAgICBgcGFja2FnZUdyb3VwIG1ldGFkYXRhIG9mIHBhY2thZ2UgJHtwYWNrYWdlSnNvbi5uYW1lfSBpcyBtYWxmb3JtZWQuIElnbm9yaW5nLmAsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXN1bHQucGFja2FnZUdyb3VwID0gcGFja2FnZUdyb3VwO1xuICAgIH1cbiAgfVxuXG4gIGlmIChtZXRhZGF0YVsncmVxdWlyZW1lbnRzJ10pIHtcbiAgICBjb25zdCByZXF1aXJlbWVudHMgPSBtZXRhZGF0YVsncmVxdWlyZW1lbnRzJ107XG4gICAgLy8gVmVyaWZ5IHRoYXQgcmVxdWlyZW1lbnRzIGFyZVxuICAgIGlmICh0eXBlb2YgcmVxdWlyZW1lbnRzICE9ICdvYmplY3QnXG4gICAgICAgIHx8IEFycmF5LmlzQXJyYXkocmVxdWlyZW1lbnRzKVxuICAgICAgICB8fCBPYmplY3Qua2V5cyhyZXF1aXJlbWVudHMpLnNvbWUobmFtZSA9PiB0eXBlb2YgcmVxdWlyZW1lbnRzW25hbWVdICE9ICdzdHJpbmcnKSkge1xuICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgIGByZXF1aXJlbWVudHMgbWV0YWRhdGEgb2YgcGFja2FnZSAke3BhY2thZ2VKc29uLm5hbWV9IGlzIG1hbGZvcm1lZC4gSWdub3JpbmcuYCxcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdC5yZXF1aXJlbWVudHMgPSByZXF1aXJlbWVudHM7XG4gICAgfVxuICB9XG5cbiAgaWYgKG1ldGFkYXRhWydtaWdyYXRpb25zJ10pIHtcbiAgICBjb25zdCBtaWdyYXRpb25zID0gbWV0YWRhdGFbJ21pZ3JhdGlvbnMnXTtcbiAgICBpZiAodHlwZW9mIG1pZ3JhdGlvbnMgIT0gJ3N0cmluZycpIHtcbiAgICAgIGxvZ2dlci53YXJuKGBtaWdyYXRpb25zIG1ldGFkYXRhIG9mIHBhY2thZ2UgJHtwYWNrYWdlSnNvbi5uYW1lfSBpcyBtYWxmb3JtZWQuIElnbm9yaW5nLmApO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXN1bHQubWlncmF0aW9ucyA9IG1pZ3JhdGlvbnM7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuXG5mdW5jdGlvbiBfdXNhZ2VNZXNzYWdlKFxuICBvcHRpb25zOiBVcGRhdGVTY2hlbWEsXG4gIGluZm9NYXA6IE1hcDxzdHJpbmcsIFBhY2thZ2VJbmZvPixcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbikge1xuICBjb25zdCBwYWNrYWdlc1RvVXBkYXRlID0gWy4uLmluZm9NYXAuZW50cmllcygpXVxuICAgIC5zb3J0KClcbiAgICAubWFwKChbbmFtZSwgaW5mb10pID0+IHtcbiAgICAgIGNvbnN0IHRhZyA9IG9wdGlvbnMubmV4dCA/ICduZXh0JyA6ICdsYXRlc3QnO1xuICAgICAgY29uc3QgdmVyc2lvbiA9IGluZm8ubnBtUGFja2FnZUpzb25bJ2Rpc3QtdGFncyddW3RhZ107XG4gICAgICBjb25zdCB0YXJnZXQgPSBpbmZvLm5wbVBhY2thZ2VKc29uLnZlcnNpb25zW3ZlcnNpb25dO1xuXG4gICAgICByZXR1cm4gW1xuICAgICAgICBuYW1lLFxuICAgICAgICBpbmZvLFxuICAgICAgICB2ZXJzaW9uLFxuICAgICAgICB0YXJnZXQsXG4gICAgICBdIGFzIFtzdHJpbmcsIFBhY2thZ2VJbmZvLCBzdHJpbmcsIEpzb25TY2hlbWFGb3JOcG1QYWNrYWdlSnNvbkZpbGVzXTtcbiAgICB9KVxuICAgIC5maWx0ZXIoKFtuYW1lLCBpbmZvLCB2ZXJzaW9uLCB0YXJnZXRdKSA9PiB7XG4gICAgICByZXR1cm4gKHRhcmdldCAmJiBzZW12ZXIuY29tcGFyZShpbmZvLmluc3RhbGxlZC52ZXJzaW9uLCB2ZXJzaW9uKSA8IDApO1xuICAgIH0pXG4gICAgLmZpbHRlcigoWywgLCAsIHRhcmdldF0pID0+IHtcbiAgICAgIHJldHVybiB0YXJnZXRbJ25nLXVwZGF0ZSddO1xuICAgIH0pO1xuXG4gIGlmIChwYWNrYWdlc1RvVXBkYXRlLmxlbmd0aCA9PSAwKSB7XG4gICAgbG9nZ2VyLmluZm8oJ1dlIGFuYWx5emVkIHlvdXIgcGFja2FnZS5qc29uIGFuZCBldmVyeXRoaW5nIHNlZW1zIHRvIGJlIGluIG9yZGVyLiBHb29kIHdvcmshJyk7XG5cbiAgICByZXR1cm4gb2Y8dm9pZD4odW5kZWZpbmVkKTtcbiAgfVxuXG4gIGxvZ2dlci5pbmZvKFxuICAgICdXZSBhbmFseXplZCB5b3VyIHBhY2thZ2UuanNvbiwgdGhlcmUgYXJlIHNvbWUgcGFja2FnZXMgdG8gdXBkYXRlOlxcbicsXG4gICk7XG5cbiAgLy8gRmluZCB0aGUgbGFyZ2VzdCBuYW1lIHRvIGtub3cgdGhlIHBhZGRpbmcgbmVlZGVkLlxuICBsZXQgbmFtZVBhZCA9IE1hdGgubWF4KC4uLlsuLi5pbmZvTWFwLmtleXMoKV0ubWFwKHggPT4geC5sZW5ndGgpKSArIDI7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKG5hbWVQYWQpKSB7XG4gICAgbmFtZVBhZCA9IDMwO1xuICB9XG5cbiAgbG9nZ2VyLmluZm8oXG4gICAgJyAgJ1xuICAgICsgJ05hbWUnLnBhZEVuZChuYW1lUGFkKVxuICAgICsgJ1ZlcnNpb24nLnBhZEVuZCgyNSlcbiAgICArICcgIENvbW1hbmQgdG8gdXBkYXRlJyxcbiAgKTtcbiAgbG9nZ2VyLmluZm8oJyAnICsgJy0nLnJlcGVhdChuYW1lUGFkICogMiArIDM1KSk7XG5cbiAgcGFja2FnZXNUb1VwZGF0ZS5mb3JFYWNoKChbbmFtZSwgaW5mbywgdmVyc2lvbiwgdGFyZ2V0XSkgPT4ge1xuICAgIGxldCBjb21tYW5kID0gYG5wbSBpbnN0YWxsICR7bmFtZX1gO1xuICAgIGlmICh0YXJnZXQgJiYgdGFyZ2V0WyduZy11cGRhdGUnXSkge1xuICAgICAgLy8gU2hvdyB0aGUgbmcgY29tbWFuZCBvbmx5IHdoZW4gbWlncmF0aW9ucyBhcmUgc3VwcG9ydGVkLCBvdGhlcndpc2UgaXQncyBhIGZhbmN5XG4gICAgICAvLyBucG0gaW5zdGFsbCwgcmVhbGx5LlxuICAgICAgY29tbWFuZCA9IGBuZyB1cGRhdGUgJHtuYW1lfWA7XG4gICAgfVxuXG4gICAgbG9nZ2VyLmluZm8oXG4gICAgICAnICAnXG4gICAgICArIG5hbWUucGFkRW5kKG5hbWVQYWQpXG4gICAgICArIGAke2luZm8uaW5zdGFsbGVkLnZlcnNpb259IC0+ICR7dmVyc2lvbn1gLnBhZEVuZCgyNSlcbiAgICAgICsgJyAgJyArIGNvbW1hbmQsXG4gICAgKTtcbiAgfSk7XG5cbiAgbG9nZ2VyLmluZm8oJ1xcbicpO1xuICBsb2dnZXIuaW5mbygnVGhlcmUgbWlnaHQgYmUgYWRkaXRpb25hbCBwYWNrYWdlcyB0aGF0IGFyZSBvdXRkYXRlZC4nKTtcbiAgbG9nZ2VyLmluZm8oJ09yIHJ1biBuZyB1cGRhdGUgLS1hbGwgdG8gdHJ5IHRvIHVwZGF0ZSBhbGwgYXQgdGhlIHNhbWUgdGltZS5cXG4nKTtcblxuICByZXR1cm4gb2Y8dm9pZD4odW5kZWZpbmVkKTtcbn1cblxuXG5mdW5jdGlvbiBfYnVpbGRQYWNrYWdlSW5mbyhcbiAgdHJlZTogVHJlZSxcbiAgcGFja2FnZXM6IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4sXG4gIGFsbERlcGVuZGVuY2llczogTWFwPHN0cmluZywgVmVyc2lvblJhbmdlPixcbiAgbnBtUGFja2FnZUpzb246IE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbixcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IFBhY2thZ2VJbmZvIHtcbiAgY29uc3QgbmFtZSA9IG5wbVBhY2thZ2VKc29uLm5hbWU7XG4gIGNvbnN0IHBhY2thZ2VKc29uUmFuZ2UgPSBhbGxEZXBlbmRlbmNpZXMuZ2V0KG5hbWUpO1xuICBpZiAoIXBhY2thZ2VKc29uUmFuZ2UpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbihcbiAgICAgIGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkobmFtZSl9IHdhcyBub3QgZm91bmQgaW4gcGFja2FnZS5qc29uLmAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIEZpbmQgb3V0IHRoZSBjdXJyZW50bHkgaW5zdGFsbGVkIHZlcnNpb24uIEVpdGhlciBmcm9tIHRoZSBwYWNrYWdlLmpzb24gb3IgdGhlIG5vZGVfbW9kdWxlcy9cbiAgLy8gVE9ETzogZmlndXJlIG91dCBhIHdheSB0byByZWFkIHBhY2thZ2UtbG9jay5qc29uIGFuZC9vciB5YXJuLmxvY2suXG4gIGxldCBpbnN0YWxsZWRWZXJzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHBhY2thZ2VDb250ZW50ID0gdHJlZS5yZWFkKGAvbm9kZV9tb2R1bGVzLyR7bmFtZX0vcGFja2FnZS5qc29uYCk7XG4gIGlmIChwYWNrYWdlQ29udGVudCkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBKU09OLnBhcnNlKHBhY2thZ2VDb250ZW50LnRvU3RyaW5nKCkpIGFzIEpzb25TY2hlbWFGb3JOcG1QYWNrYWdlSnNvbkZpbGVzO1xuICAgIGluc3RhbGxlZFZlcnNpb24gPSBjb250ZW50LnZlcnNpb247XG4gIH1cbiAgaWYgKCFpbnN0YWxsZWRWZXJzaW9uKSB7XG4gICAgLy8gRmluZCB0aGUgdmVyc2lvbiBmcm9tIE5QTSB0aGF0IGZpdHMgdGhlIHJhbmdlIHRvIG1heC5cbiAgICBpbnN0YWxsZWRWZXJzaW9uID0gc2VtdmVyLm1heFNhdGlzZnlpbmcoXG4gICAgICBPYmplY3Qua2V5cyhucG1QYWNrYWdlSnNvbi52ZXJzaW9ucyksXG4gICAgICBwYWNrYWdlSnNvblJhbmdlLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBpbnN0YWxsZWRQYWNrYWdlSnNvbiA9IG5wbVBhY2thZ2VKc29uLnZlcnNpb25zW2luc3RhbGxlZFZlcnNpb25dIHx8IHBhY2thZ2VDb250ZW50O1xuICBpZiAoIWluc3RhbGxlZFBhY2thZ2VKc29uKSB7XG4gICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oXG4gICAgICBgQW4gdW5leHBlY3RlZCBlcnJvciBoYXBwZW5lZDsgcGFja2FnZSAke25hbWV9IGhhcyBubyB2ZXJzaW9uICR7aW5zdGFsbGVkVmVyc2lvbn0uYCxcbiAgICApO1xuICB9XG5cbiAgbGV0IHRhcmdldFZlcnNpb246IFZlcnNpb25SYW5nZSB8IHVuZGVmaW5lZCA9IHBhY2thZ2VzLmdldChuYW1lKTtcbiAgaWYgKHRhcmdldFZlcnNpb24pIHtcbiAgICBpZiAobnBtUGFja2FnZUpzb25bJ2Rpc3QtdGFncyddW3RhcmdldFZlcnNpb25dKSB7XG4gICAgICB0YXJnZXRWZXJzaW9uID0gbnBtUGFja2FnZUpzb25bJ2Rpc3QtdGFncyddW3RhcmdldFZlcnNpb25dIGFzIFZlcnNpb25SYW5nZTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGFyZ2V0VmVyc2lvbiA9IHNlbXZlci5tYXhTYXRpc2Z5aW5nKFxuICAgICAgICBPYmplY3Qua2V5cyhucG1QYWNrYWdlSnNvbi52ZXJzaW9ucyksXG4gICAgICAgIHRhcmdldFZlcnNpb24sXG4gICAgICApIGFzIFZlcnNpb25SYW5nZTtcbiAgICB9XG4gIH1cblxuICBpZiAodGFyZ2V0VmVyc2lvbiAmJiBzZW12ZXIubHRlKHRhcmdldFZlcnNpb24sIGluc3RhbGxlZFZlcnNpb24pKSB7XG4gICAgbG9nZ2VyLmRlYnVnKGBQYWNrYWdlICR7bmFtZX0gYWxyZWFkeSBzYXRpc2ZpZWQgYnkgcGFja2FnZS5qc29uICgke3BhY2thZ2VKc29uUmFuZ2V9KS5gKTtcbiAgICB0YXJnZXRWZXJzaW9uID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgY29uc3QgdGFyZ2V0OiBQYWNrYWdlVmVyc2lvbkluZm8gfCB1bmRlZmluZWQgPSB0YXJnZXRWZXJzaW9uXG4gICAgPyB7XG4gICAgICB2ZXJzaW9uOiB0YXJnZXRWZXJzaW9uLFxuICAgICAgcGFja2FnZUpzb246IG5wbVBhY2thZ2VKc29uLnZlcnNpb25zW3RhcmdldFZlcnNpb25dLFxuICAgICAgdXBkYXRlTWV0YWRhdGE6IF9nZXRVcGRhdGVNZXRhZGF0YShucG1QYWNrYWdlSnNvbi52ZXJzaW9uc1t0YXJnZXRWZXJzaW9uXSwgbG9nZ2VyKSxcbiAgICB9XG4gICAgOiB1bmRlZmluZWQ7XG5cbiAgLy8gQ2hlY2sgaWYgdGhlcmUncyBhbiBpbnN0YWxsZWQgdmVyc2lvbi5cbiAgcmV0dXJuIHtcbiAgICBuYW1lLFxuICAgIG5wbVBhY2thZ2VKc29uLFxuICAgIGluc3RhbGxlZDoge1xuICAgICAgdmVyc2lvbjogaW5zdGFsbGVkVmVyc2lvbiBhcyBWZXJzaW9uUmFuZ2UsXG4gICAgICBwYWNrYWdlSnNvbjogaW5zdGFsbGVkUGFja2FnZUpzb24sXG4gICAgICB1cGRhdGVNZXRhZGF0YTogX2dldFVwZGF0ZU1ldGFkYXRhKGluc3RhbGxlZFBhY2thZ2VKc29uLCBsb2dnZXIpLFxuICAgIH0sXG4gICAgdGFyZ2V0LFxuICAgIHBhY2thZ2VKc29uUmFuZ2UsXG4gIH07XG59XG5cblxuZnVuY3Rpb24gX2J1aWxkUGFja2FnZUxpc3QoXG4gIG9wdGlvbnM6IFVwZGF0ZVNjaGVtYSxcbiAgcHJvamVjdERlcHM6IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4sXG4gIGxvZ2dlcjogbG9nZ2luZy5Mb2dnZXJBcGksXG4pOiBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+IHtcbiAgLy8gUGFyc2UgdGhlIHBhY2thZ2VzIG9wdGlvbnMgdG8gc2V0IHRoZSB0YXJnZXRlZCB2ZXJzaW9uLlxuICBjb25zdCBwYWNrYWdlcyA9IG5ldyBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+KCk7XG4gIGNvbnN0IGNvbW1hbmRMaW5lUGFja2FnZXMgPVxuICAgIChvcHRpb25zLnBhY2thZ2VzICYmIG9wdGlvbnMucGFja2FnZXMubGVuZ3RoID4gMClcbiAgICA/IG9wdGlvbnMucGFja2FnZXNcbiAgICA6IChvcHRpb25zLmFsbCA/IHByb2plY3REZXBzLmtleXMoKSA6IFtdKTtcblxuICBmb3IgKGNvbnN0IHBrZyBvZiBjb21tYW5kTGluZVBhY2thZ2VzKSB7XG4gICAgLy8gU3BsaXQgdGhlIHZlcnNpb24gYXNrZWQgb24gY29tbWFuZCBsaW5lLlxuICAgIGNvbnN0IG0gPSBwa2cubWF0Y2goL14oKD86QFteL117MSwxMDB9XFwvKT9bXkBdezEsMTAwfSkoPzpAKC57MSwxMDB9KSk/JC8pO1xuICAgIGlmICghbSkge1xuICAgICAgbG9nZ2VyLndhcm4oYEludmFsaWQgcGFja2FnZSBhcmd1bWVudDogJHtKU09OLnN0cmluZ2lmeShwa2cpfS4gU2tpcHBpbmcuYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBbLCBucG1OYW1lLCBtYXliZVZlcnNpb25dID0gbTtcblxuICAgIGNvbnN0IHZlcnNpb24gPSBwcm9qZWN0RGVwcy5nZXQobnBtTmFtZSk7XG4gICAgaWYgKCF2ZXJzaW9uKSB7XG4gICAgICBsb2dnZXIud2FybihgUGFja2FnZSBub3QgaW5zdGFsbGVkOiAke0pTT04uc3RyaW5naWZ5KG5wbU5hbWUpfS4gU2tpcHBpbmcuYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBWZXJpZnkgdGhhdCBwZW9wbGUgaGF2ZSBhbiBhY3R1YWwgdmVyc2lvbiBpbiB0aGUgcGFja2FnZS5qc29uLCBvdGhlcndpc2UgKGxhYmVsIG9yIFVSTCBvclxuICAgIC8vIGdpc3Qgb3IgLi4uKSB3ZSBkb24ndCB1cGRhdGUgaXQuXG4gICAgaWYgKFxuICAgICAgdmVyc2lvbi5zdGFydHNXaXRoKCdodHRwOicpICAvLyBIVFRQXG4gICAgICB8fCB2ZXJzaW9uLnN0YXJ0c1dpdGgoJ2ZpbGU6JykgIC8vIExvY2FsIGZvbGRlclxuICAgICAgfHwgdmVyc2lvbi5zdGFydHNXaXRoKCdnaXQ6JykgIC8vIEdJVCB1cmxcbiAgICAgIHx8IHZlcnNpb24ubWF0Y2goL15cXHd7MSwxMDB9XFwvXFx3ezEsMTAwfS8pICAvLyBHaXRIdWIncyBcInVzZXIvcmVwb1wiXG4gICAgICB8fCB2ZXJzaW9uLm1hdGNoKC9eKD86XFwuezAsMn1cXC8pXFx3ezEsMTAwfS8pICAvLyBMb2NhbCBmb2xkZXIsIG1heWJlIHJlbGF0aXZlLlxuICAgICkge1xuICAgICAgLy8gV2Ugb25seSBkbyB0aGF0IGZvciAtLWFsbC4gT3RoZXJ3aXNlIHdlIGhhdmUgdGhlIGluc3RhbGxlZCB2ZXJzaW9uIGFuZCB0aGUgdXNlciBzcGVjaWZpZWRcbiAgICAgIC8vIGl0IG9uIHRoZSBjb21tYW5kIGxpbmUuXG4gICAgICBpZiAob3B0aW9ucy5hbGwpIHtcbiAgICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgICAgYFBhY2thZ2UgJHtKU09OLnN0cmluZ2lmeShucG1OYW1lKX0gaGFzIGEgY3VzdG9tIHZlcnNpb246IGBcbiAgICAgICAgICArIGAke0pTT04uc3RyaW5naWZ5KHZlcnNpb24pfS4gU2tpcHBpbmcuYCxcbiAgICAgICAgKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcGFja2FnZXMuc2V0KG5wbU5hbWUsIChtYXliZVZlcnNpb24gfHwgKG9wdGlvbnMubmV4dCA/ICduZXh0JyA6ICdsYXRlc3QnKSkgYXMgVmVyc2lvblJhbmdlKTtcbiAgfVxuXG4gIHJldHVybiBwYWNrYWdlcztcbn1cblxuXG5mdW5jdGlvbiBfYWRkUGFja2FnZUdyb3VwKFxuICBwYWNrYWdlczogTWFwPHN0cmluZywgVmVyc2lvblJhbmdlPixcbiAgYWxsRGVwZW5kZW5jaWVzOiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz4sXG4gIG5wbVBhY2thZ2VKc29uOiBOcG1SZXBvc2l0b3J5UGFja2FnZUpzb24sXG4gIGxvZ2dlcjogbG9nZ2luZy5Mb2dnZXJBcGksXG4pOiB2b2lkIHtcbiAgY29uc3QgbWF5YmVQYWNrYWdlID0gcGFja2FnZXMuZ2V0KG5wbVBhY2thZ2VKc29uLm5hbWUpO1xuICBpZiAoIW1heWJlUGFja2FnZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHZlcnNpb24gPSBucG1QYWNrYWdlSnNvblsnZGlzdC10YWdzJ11bbWF5YmVQYWNrYWdlXSB8fCBtYXliZVBhY2thZ2U7XG4gIGlmICghbnBtUGFja2FnZUpzb24udmVyc2lvbnNbdmVyc2lvbl0pIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbmdVcGRhdGVNZXRhZGF0YSA9IG5wbVBhY2thZ2VKc29uLnZlcnNpb25zW3ZlcnNpb25dWyduZy11cGRhdGUnXTtcbiAgaWYgKCFuZ1VwZGF0ZU1ldGFkYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcGFja2FnZUdyb3VwID0gbmdVcGRhdGVNZXRhZGF0YVsncGFja2FnZUdyb3VwJ107XG4gIGlmICghcGFja2FnZUdyb3VwKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghQXJyYXkuaXNBcnJheShwYWNrYWdlR3JvdXApIHx8IHBhY2thZ2VHcm91cC5zb21lKHggPT4gdHlwZW9mIHggIT0gJ3N0cmluZycpKSB7XG4gICAgbG9nZ2VyLndhcm4oYHBhY2thZ2VHcm91cCBtZXRhZGF0YSBvZiBwYWNrYWdlICR7bnBtUGFja2FnZUpzb24ubmFtZX0gaXMgbWFsZm9ybWVkLmApO1xuXG4gICAgcmV0dXJuO1xuICB9XG5cbiAgcGFja2FnZUdyb3VwXG4gICAgLmZpbHRlcihuYW1lID0+ICFwYWNrYWdlcy5oYXMobmFtZSkpICAvLyBEb24ndCBvdmVycmlkZSBuYW1lcyBmcm9tIHRoZSBjb21tYW5kIGxpbmUuXG4gICAgLmZpbHRlcihuYW1lID0+IGFsbERlcGVuZGVuY2llcy5oYXMobmFtZSkpICAvLyBSZW1vdmUgcGFja2FnZXMgdGhhdCBhcmVuJ3QgaW5zdGFsbGVkLlxuICAgIC5mb3JFYWNoKG5hbWUgPT4ge1xuICAgIHBhY2thZ2VzLnNldChuYW1lLCBtYXliZVBhY2thZ2UpO1xuICB9KTtcbn1cblxuLyoqXG4gKiBBZGQgcGVlciBkZXBlbmRlbmNpZXMgb2YgcGFja2FnZXMgb24gdGhlIGNvbW1hbmQgbGluZSB0byB0aGUgbGlzdCBvZiBwYWNrYWdlcyB0byB1cGRhdGUuXG4gKiBXZSBkb24ndCBkbyB2ZXJpZmljYXRpb24gb2YgdGhlIHZlcnNpb25zIGhlcmUgYXMgdGhpcyB3aWxsIGJlIGRvbmUgYnkgYSBsYXRlciBzdGVwIChhbmQgY2FuXG4gKiBiZSBpZ25vcmVkIGJ5IHRoZSAtLWZvcmNlIGZsYWcpLlxuICogQHByaXZhdGVcbiAqL1xuZnVuY3Rpb24gX2FkZFBlZXJEZXBlbmRlbmNpZXMoXG4gIHBhY2thZ2VzOiBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+LFxuICBfYWxsRGVwZW5kZW5jaWVzOiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz4sXG4gIG5wbVBhY2thZ2VKc29uOiBOcG1SZXBvc2l0b3J5UGFja2FnZUpzb24sXG4gIF9sb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IG1heWJlUGFja2FnZSA9IHBhY2thZ2VzLmdldChucG1QYWNrYWdlSnNvbi5uYW1lKTtcbiAgaWYgKCFtYXliZVBhY2thZ2UpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB2ZXJzaW9uID0gbnBtUGFja2FnZUpzb25bJ2Rpc3QtdGFncyddW21heWJlUGFja2FnZV0gfHwgbWF5YmVQYWNrYWdlO1xuICBpZiAoIW5wbVBhY2thZ2VKc29uLnZlcnNpb25zW3ZlcnNpb25dKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcGFja2FnZUpzb24gPSBucG1QYWNrYWdlSnNvbi52ZXJzaW9uc1t2ZXJzaW9uXTtcbiAgY29uc3QgZXJyb3IgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IFtwZWVyLCByYW5nZV0gb2YgT2JqZWN0LmVudHJpZXMocGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llcyB8fCB7fSkpIHtcbiAgICBpZiAoIXBhY2thZ2VzLmhhcyhwZWVyKSkge1xuICAgICAgcGFja2FnZXMuc2V0KHBlZXIsIHJhbmdlIGFzIFZlcnNpb25SYW5nZSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKGVycm9yKSB7XG4gICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oJ0FuIGVycm9yIG9jY3VyZWQsIHNlZSBhYm92ZS4nKTtcbiAgfVxufVxuXG5cbmZ1bmN0aW9uIF9nZXRBbGxEZXBlbmRlbmNpZXModHJlZTogVHJlZSk6IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4ge1xuICBjb25zdCBwYWNrYWdlSnNvbkNvbnRlbnQgPSB0cmVlLnJlYWQoJy9wYWNrYWdlLmpzb24nKTtcbiAgaWYgKCFwYWNrYWdlSnNvbkNvbnRlbnQpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbignQ291bGQgbm90IGZpbmQgYSBwYWNrYWdlLmpzb24uIEFyZSB5b3UgaW4gYSBOb2RlIHByb2plY3Q/Jyk7XG4gIH1cblxuICBsZXQgcGFja2FnZUpzb246IEpzb25TY2hlbWFGb3JOcG1QYWNrYWdlSnNvbkZpbGVzO1xuICB0cnkge1xuICAgIHBhY2thZ2VKc29uID0gSlNPTi5wYXJzZShwYWNrYWdlSnNvbkNvbnRlbnQudG9TdHJpbmcoKSkgYXMgSnNvblNjaGVtYUZvck5wbVBhY2thZ2VKc29uRmlsZXM7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbigncGFja2FnZS5qc29uIGNvdWxkIG5vdCBiZSBwYXJzZWQ6ICcgKyBlLm1lc3NhZ2UpO1xuICB9XG5cbiAgcmV0dXJuIG5ldyBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+KFtcbiAgICAuLi5PYmplY3QuZW50cmllcyhwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzIHx8IHt9KSxcbiAgICAuLi5PYmplY3QuZW50cmllcyhwYWNrYWdlSnNvbi5kZXZEZXBlbmRlbmNpZXMgfHwge30pLFxuICAgIC4uLk9iamVjdC5lbnRyaWVzKHBhY2thZ2VKc29uLmRlcGVuZGVuY2llcyB8fCB7fSksXG4gIF0gYXMgW3N0cmluZywgVmVyc2lvblJhbmdlXVtdKTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24ob3B0aW9uczogVXBkYXRlU2NoZW1hKTogUnVsZSB7XG4gIGlmICghb3B0aW9ucy5wYWNrYWdlcykge1xuICAgIC8vIFdlIGNhbm5vdCBqdXN0IHJldHVybiB0aGlzIGJlY2F1c2Ugd2UgbmVlZCB0byBmZXRjaCB0aGUgcGFja2FnZXMgZnJvbSBOUE0gc3RpbGwgZm9yIHRoZVxuICAgIC8vIGhlbHAvZ3VpZGUgdG8gc2hvdy5cbiAgICBvcHRpb25zLnBhY2thZ2VzID0gW107XG4gIH0gZWxzZSBpZiAodHlwZW9mIG9wdGlvbnMucGFja2FnZXMgPT0gJ3N0cmluZycpIHtcbiAgICAvLyBJZiBhIHN0cmluZywgdGhlbiB3ZSBzaG91bGQgc3BsaXQgaXQgYW5kIG1ha2UgaXQgYW4gYXJyYXkuXG4gICAgb3B0aW9ucy5wYWNrYWdlcyA9IG9wdGlvbnMucGFja2FnZXMuc3BsaXQoLywvZyk7XG4gIH1cblxuICBpZiAob3B0aW9ucy5taWdyYXRlT25seSAmJiBvcHRpb25zLmZyb20pIHtcbiAgICBpZiAob3B0aW9ucy5wYWNrYWdlcy5sZW5ndGggIT09IDEpIHtcbiAgICAgIHRocm93IG5ldyBTY2hlbWF0aWNzRXhjZXB0aW9uKCctLWZyb20gcmVxdWlyZXMgdGhhdCBvbmx5IGEgc2luZ2xlIHBhY2thZ2UgYmUgcGFzc2VkLicpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiAodHJlZTogVHJlZSwgY29udGV4dDogU2NoZW1hdGljQ29udGV4dCkgPT4ge1xuICAgIGNvbnN0IGxvZ2dlciA9IGNvbnRleHQubG9nZ2VyO1xuICAgIGNvbnN0IGFsbERlcGVuZGVuY2llcyA9IF9nZXRBbGxEZXBlbmRlbmNpZXModHJlZSk7XG4gICAgY29uc3QgcGFja2FnZXMgPSBfYnVpbGRQYWNrYWdlTGlzdChvcHRpb25zLCBhbGxEZXBlbmRlbmNpZXMsIGxvZ2dlcik7XG5cbiAgICByZXR1cm4gb2JzZXJ2YWJsZUZyb20oWy4uLmFsbERlcGVuZGVuY2llcy5rZXlzKCldKS5waXBlKFxuICAgICAgLy8gR3JhYiBhbGwgcGFja2FnZS5qc29uIGZyb20gdGhlIG5wbSByZXBvc2l0b3J5LiBUaGlzIHJlcXVpcmVzIGEgbG90IG9mIEhUVFAgY2FsbHMgc28gd2VcbiAgICAgIC8vIHRyeSB0byBwYXJhbGxlbGl6ZSBhcyBtYW55IGFzIHBvc3NpYmxlLlxuICAgICAgbWVyZ2VNYXAoZGVwTmFtZSA9PiBnZXROcG1QYWNrYWdlSnNvbihkZXBOYW1lLCBvcHRpb25zLnJlZ2lzdHJ5LCBsb2dnZXIpKSxcblxuICAgICAgLy8gQnVpbGQgYSBtYXAgb2YgYWxsIGRlcGVuZGVuY2llcyBhbmQgdGhlaXIgcGFja2FnZUpzb24uXG4gICAgICByZWR1Y2U8TnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uLCBNYXA8c3RyaW5nLCBOcG1SZXBvc2l0b3J5UGFja2FnZUpzb24+PihcbiAgICAgICAgKGFjYywgbnBtUGFja2FnZUpzb24pID0+IHtcbiAgICAgICAgICAvLyBJZiB0aGUgcGFja2FnZSB3YXMgbm90IGZvdW5kIG9uIHRoZSByZWdpc3RyeS4gSXQgY291bGQgYmUgcHJpdmF0ZSwgc28gd2Ugd2lsbCBqdXN0XG4gICAgICAgICAgLy8gaWdub3JlLiBJZiB0aGUgcGFja2FnZSB3YXMgcGFydCBvZiB0aGUgbGlzdCwgd2Ugd2lsbCBlcnJvciBvdXQsIGJ1dCB3aWxsIHNpbXBseSBpZ25vcmVcbiAgICAgICAgICAvLyBpZiBpdCdzIGVpdGhlciBub3QgcmVxdWVzdGVkIChzbyBqdXN0IHBhcnQgb2YgcGFja2FnZS5qc29uLiBzaWxlbnRseSkgb3IgaWYgaXQncyBhXG4gICAgICAgICAgLy8gYC0tYWxsYCBzaXR1YXRpb24uIFRoZXJlIGlzIGFuIGVkZ2UgY2FzZSBoZXJlIHdoZXJlIGEgcHVibGljIHBhY2thZ2UgcGVlciBkZXBlbmRzIG9uIGFcbiAgICAgICAgICAvLyBwcml2YXRlIG9uZSwgYnV0IGl0J3MgcmFyZSBlbm91Z2guXG4gICAgICAgICAgaWYgKCFucG1QYWNrYWdlSnNvbi5uYW1lKSB7XG4gICAgICAgICAgICBpZiAocGFja2FnZXMuaGFzKG5wbVBhY2thZ2VKc29uLnJlcXVlc3RlZE5hbWUpKSB7XG4gICAgICAgICAgICAgIGlmIChvcHRpb25zLmFsbCkge1xuICAgICAgICAgICAgICAgIGxvZ2dlci53YXJuKGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkobnBtUGFja2FnZUpzb24ucmVxdWVzdGVkTmFtZSl9IHdhcyBub3QgYFxuICAgICAgICAgICAgICAgICAgKyAnZm91bmQgb24gdGhlIHJlZ2lzdHJ5LiBTa2lwcGluZy4nKTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbihcbiAgICAgICAgICAgICAgICAgIGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkobnBtUGFja2FnZUpzb24ucmVxdWVzdGVkTmFtZSl9IHdhcyBub3QgZm91bmQgb24gdGhlIGBcbiAgICAgICAgICAgICAgICAgICsgJ3JlZ2lzdHJ5LiBDYW5ub3QgY29udGludWUgYXMgdGhpcyBtYXkgYmUgYW4gZXJyb3IuJyk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYWNjLnNldChucG1QYWNrYWdlSnNvbi5uYW1lLCBucG1QYWNrYWdlSnNvbik7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIGFjYztcbiAgICAgICAgfSxcbiAgICAgICAgbmV3IE1hcDxzdHJpbmcsIE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbj4oKSxcbiAgICAgICksXG5cbiAgICAgIG1hcChucG1QYWNrYWdlSnNvbk1hcCA9PiB7XG4gICAgICAgIC8vIEF1Z21lbnQgdGhlIGNvbW1hbmQgbGluZSBwYWNrYWdlIGxpc3Qgd2l0aCBwYWNrYWdlR3JvdXBzIGFuZCBmb3J3YXJkIHBlZXIgZGVwZW5kZW5jaWVzLlxuICAgICAgICBucG1QYWNrYWdlSnNvbk1hcC5mb3JFYWNoKChucG1QYWNrYWdlSnNvbikgPT4ge1xuICAgICAgICAgIF9hZGRQYWNrYWdlR3JvdXAocGFja2FnZXMsIGFsbERlcGVuZGVuY2llcywgbnBtUGFja2FnZUpzb24sIGxvZ2dlcik7XG4gICAgICAgICAgX2FkZFBlZXJEZXBlbmRlbmNpZXMocGFja2FnZXMsIGFsbERlcGVuZGVuY2llcywgbnBtUGFja2FnZUpzb24sIGxvZ2dlcik7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEJ1aWxkIHRoZSBQYWNrYWdlSW5mbyBmb3IgZWFjaCBtb2R1bGUuXG4gICAgICAgIGNvbnN0IHBhY2thZ2VJbmZvTWFwID0gbmV3IE1hcDxzdHJpbmcsIFBhY2thZ2VJbmZvPigpO1xuICAgICAgICBucG1QYWNrYWdlSnNvbk1hcC5mb3JFYWNoKChucG1QYWNrYWdlSnNvbikgPT4ge1xuICAgICAgICAgIHBhY2thZ2VJbmZvTWFwLnNldChcbiAgICAgICAgICAgIG5wbVBhY2thZ2VKc29uLm5hbWUsXG4gICAgICAgICAgICBfYnVpbGRQYWNrYWdlSW5mbyh0cmVlLCBwYWNrYWdlcywgYWxsRGVwZW5kZW5jaWVzLCBucG1QYWNrYWdlSnNvbiwgbG9nZ2VyKSxcbiAgICAgICAgICApO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcGFja2FnZUluZm9NYXA7XG4gICAgICB9KSxcblxuICAgICAgc3dpdGNoTWFwKGluZm9NYXAgPT4ge1xuICAgICAgICAvLyBOb3cgdGhhdCB3ZSBoYXZlIGFsbCB0aGUgaW5mb3JtYXRpb24sIGNoZWNrIHRoZSBmbGFncy5cbiAgICAgICAgaWYgKHBhY2thZ2VzLnNpemUgPiAwKSB7XG4gICAgICAgICAgaWYgKG9wdGlvbnMubWlncmF0ZU9ubHkgJiYgb3B0aW9ucy5mcm9tICYmIG9wdGlvbnMucGFja2FnZXMpIHtcbiAgICAgICAgICAgIHJldHVybiBfbWlncmF0ZU9ubHkoXG4gICAgICAgICAgICAgIGluZm9NYXAuZ2V0KG9wdGlvbnMucGFja2FnZXNbMF0pLFxuICAgICAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgICAgICBvcHRpb25zLmZyb20sXG4gICAgICAgICAgICAgIG9wdGlvbnMudG8sXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHN1YmxvZyA9IG5ldyBsb2dnaW5nLkxldmVsQ2FwTG9nZ2VyKFxuICAgICAgICAgICAgJ3ZhbGlkYXRpb24nLFxuICAgICAgICAgICAgbG9nZ2VyLmNyZWF0ZUNoaWxkKCcnKSxcbiAgICAgICAgICAgICd3YXJuJyxcbiAgICAgICAgICApO1xuICAgICAgICAgIF92YWxpZGF0ZVVwZGF0ZVBhY2thZ2VzKGluZm9NYXAsIG9wdGlvbnMuZm9yY2UsIHN1YmxvZyk7XG5cbiAgICAgICAgICByZXR1cm4gX3BlcmZvcm1VcGRhdGUodHJlZSwgY29udGV4dCwgaW5mb01hcCwgbG9nZ2VyLCBvcHRpb25zLm1pZ3JhdGVPbmx5KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gX3VzYWdlTWVzc2FnZShvcHRpb25zLCBpbmZvTWFwLCBsb2dnZXIpO1xuICAgICAgICB9XG4gICAgICB9KSxcblxuICAgICAgc3dpdGNoTWFwKCgpID0+IG9mKHRyZWUpKSxcbiAgICApO1xuICB9O1xufVxuIl19