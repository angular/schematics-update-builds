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
function _performUpdate(tree, context, infoMap, logger) {
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
    if (packageJsonContent.toString() != newContent) {
        // If something changed, also hook up the task.
        tree.overwrite('/package.json', JSON.stringify(packageJson, null, 2));
        const installTask = context.addTask(new tasks_1.NodePackageInstallTask());
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
            }), [installTask]);
        });
    }
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
    [...infoMap.entries()].sort().forEach(([name, info]) => {
        const tag = options.next ? 'next' : 'latest';
        const version = info.npmPackageJson['dist-tags'][tag];
        const target = info.npmPackageJson.versions[version];
        if (target && semver.compare(info.installed.version, version) < 0) {
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
        }
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
                const sublog = new core_1.logging.LevelCapLogger('validation', logger.createChild(''), 'warn');
                _validateUpdatePackages(infoMap, options.force, sublog);
                return _performUpdate(tree, context, infoMap, logger);
            }
            else {
                return _usageMessage(options, infoMap, logger);
            }
        }), operators_1.switchMap(() => rxjs_1.of(tree)));
    };
}
exports.default = default_1;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiLi8iLCJzb3VyY2VzIjpbInBhY2thZ2VzL3NjaGVtYXRpY3MvdXBkYXRlL3VwZGF0ZS9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBOzs7Ozs7R0FNRztBQUNILCtDQUErQztBQUMvQywyREFBK0Y7QUFDL0YsNERBQTRGO0FBQzVGLCtCQUE4RDtBQUM5RCw4Q0FBa0U7QUFDbEUsaUNBQWlDO0FBQ2pDLCtCQUEwQztBQTJCMUMsMENBQ0UsSUFBWSxFQUNaLE9BQWlDLEVBQ2pDLEtBQStCLEVBQy9CLE1BQXlCO0lBRXpCLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbEQsTUFBTSxDQUFDLEtBQUssQ0FBQyx5QkFBeUIsSUFBSSxLQUFLLENBQUMsQ0FBQztRQUNqRCxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3hDLEVBQUUsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQztZQUNuQixNQUFNLENBQUMsS0FBSyxDQUFDO2dCQUNYLFdBQVcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsbUNBQW1DO2dCQUNsRSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsR0FBRzthQUN0RCxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBRWIsTUFBTSxDQUFDLElBQUksQ0FBQztRQUNkLENBQUM7UUFFRCxNQUFNLFdBQVcsR0FBRyxhQUFhLENBQUMsTUFBTSxJQUFJLGFBQWEsQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLE9BQU87WUFDbEYsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLE9B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LElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUN0QixNQUFNLE1BQU0sR0FBRyxJQUFJLGNBQU8sQ0FBQyxjQUFjLENBQ3ZDLFlBQVksRUFDWixNQUFNLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxFQUN0QixNQUFNLENBQ1AsQ0FBQztnQkFDRix1QkFBdUIsQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDLEtBQUssRUFBRSxNQUFNLENBQUMsQ0FBQztnQkFFeEQsTUFBTSxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQztZQUN4RCxDQUFDO1lBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ04sTUFBTSxDQUFDLGFBQWEsQ0FBQyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQ2pELENBQUM7UUFDSCxDQUFDLENBQUMsRUFFRixxQkFBUyxDQUFDLEdBQUcsRUFBRSxDQUFDLFNBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUMxQixDQUFDO0lBQ0osQ0FBQyxDQUFDO0FBQ0osQ0FBQztBQWhFRCw0QkFnRUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEBsaWNlbnNlXG4gKiBDb3B5cmlnaHQgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cbiAqXG4gKiBVc2Ugb2YgdGhpcyBzb3VyY2UgY29kZSBpcyBnb3Zlcm5lZCBieSBhbiBNSVQtc3R5bGUgbGljZW5zZSB0aGF0IGNhbiBiZVxuICogZm91bmQgaW4gdGhlIExJQ0VOU0UgZmlsZSBhdCBodHRwczovL2FuZ3VsYXIuaW8vbGljZW5zZVxuICovXG5pbXBvcnQgeyBsb2dnaW5nIH0gZnJvbSAnQGFuZ3VsYXItZGV2a2l0L2NvcmUnO1xuaW1wb3J0IHsgUnVsZSwgU2NoZW1hdGljQ29udGV4dCwgU2NoZW1hdGljc0V4Y2VwdGlvbiwgVHJlZSB9IGZyb20gJ0Bhbmd1bGFyLWRldmtpdC9zY2hlbWF0aWNzJztcbmltcG9ydCB7IE5vZGVQYWNrYWdlSW5zdGFsbFRhc2ssIFJ1blNjaGVtYXRpY1Rhc2sgfSBmcm9tICdAYW5ndWxhci1kZXZraXQvc2NoZW1hdGljcy90YXNrcyc7XG5pbXBvcnQgeyBPYnNlcnZhYmxlLCBmcm9tIGFzIG9ic2VydmFibGVGcm9tLCBvZiB9IGZyb20gJ3J4anMnO1xuaW1wb3J0IHsgbWFwLCBtZXJnZU1hcCwgcmVkdWNlLCBzd2l0Y2hNYXAgfSBmcm9tICdyeGpzL29wZXJhdG9ycyc7XG5pbXBvcnQgKiBhcyBzZW12ZXIgZnJvbSAnc2VtdmVyJztcbmltcG9ydCB7IGdldE5wbVBhY2thZ2VKc29uIH0gZnJvbSAnLi9ucG0nO1xuaW1wb3J0IHsgTnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uIH0gZnJvbSAnLi9ucG0tcGFja2FnZS1qc29uJztcbmltcG9ydCB7IEpzb25TY2hlbWFGb3JOcG1QYWNrYWdlSnNvbkZpbGVzIH0gZnJvbSAnLi9wYWNrYWdlLWpzb24nO1xuaW1wb3J0IHsgVXBkYXRlU2NoZW1hIH0gZnJvbSAnLi9zY2hlbWEnO1xuXG50eXBlIFZlcnNpb25SYW5nZSA9IHN0cmluZyAmIHsgX186IHZvaWQ7IH07XG5cbmludGVyZmFjZSBQYWNrYWdlVmVyc2lvbkluZm8ge1xuICB2ZXJzaW9uOiBWZXJzaW9uUmFuZ2U7XG4gIHBhY2thZ2VKc29uOiBKc29uU2NoZW1hRm9yTnBtUGFja2FnZUpzb25GaWxlcztcbiAgdXBkYXRlTWV0YWRhdGE6IFVwZGF0ZU1ldGFkYXRhO1xufVxuXG5pbnRlcmZhY2UgUGFja2FnZUluZm8ge1xuICBuYW1lOiBzdHJpbmc7XG4gIG5wbVBhY2thZ2VKc29uOiBOcG1SZXBvc2l0b3J5UGFja2FnZUpzb247XG4gIGluc3RhbGxlZDogUGFja2FnZVZlcnNpb25JbmZvO1xuICB0YXJnZXQ/OiBQYWNrYWdlVmVyc2lvbkluZm87XG4gIHBhY2thZ2VKc29uUmFuZ2U6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFVwZGF0ZU1ldGFkYXRhIHtcbiAgcGFja2FnZUdyb3VwOiBzdHJpbmdbXTtcbiAgcmVxdWlyZW1lbnRzOiB7IFtwYWNrYWdlTmFtZTogc3RyaW5nXTogc3RyaW5nIH07XG4gIG1pZ3JhdGlvbnM/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIF92YWxpZGF0ZUZvcndhcmRQZWVyRGVwZW5kZW5jaWVzKFxuICBuYW1lOiBzdHJpbmcsXG4gIGluZm9NYXA6IE1hcDxzdHJpbmcsIFBhY2thZ2VJbmZvPixcbiAgcGVlcnM6IHtbbmFtZTogc3RyaW5nXTogc3RyaW5nfSxcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IGJvb2xlYW4ge1xuICBmb3IgKGNvbnN0IFtwZWVyLCByYW5nZV0gb2YgT2JqZWN0LmVudHJpZXMocGVlcnMpKSB7XG4gICAgbG9nZ2VyLmRlYnVnKGBDaGVja2luZyBmb3J3YXJkIHBlZXIgJHtwZWVyfS4uLmApO1xuICAgIGNvbnN0IG1heWJlUGVlckluZm8gPSBpbmZvTWFwLmdldChwZWVyKTtcbiAgICBpZiAoIW1heWJlUGVlckluZm8pIHtcbiAgICAgIGxvZ2dlci5lcnJvcihbXG4gICAgICAgIGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkobmFtZSl9IGhhcyBhIG1pc3NpbmcgcGVlciBkZXBlbmRlbmN5IG9mYCxcbiAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkocGVlcil9IEAgJHtKU09OLnN0cmluZ2lmeShyYW5nZSl9LmAsXG4gICAgICBdLmpvaW4oJyAnKSk7XG5cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHBlZXJWZXJzaW9uID0gbWF5YmVQZWVySW5mby50YXJnZXQgJiYgbWF5YmVQZWVySW5mby50YXJnZXQucGFja2FnZUpzb24udmVyc2lvblxuICAgICAgPyBtYXliZVBlZXJJbmZvLnRhcmdldC5wYWNrYWdlSnNvbi52ZXJzaW9uXG4gICAgICA6IG1heWJlUGVlckluZm8uaW5zdGFsbGVkLnZlcnNpb247XG5cbiAgICBsb2dnZXIuZGVidWcoYCAgUmFuZ2UgaW50ZXJzZWN0cygke3JhbmdlfSwgJHtwZWVyVmVyc2lvbn0pLi4uYCk7XG4gICAgaWYgKCFzZW12ZXIuc2F0aXNmaWVzKHBlZXJWZXJzaW9uLCByYW5nZSkpIHtcbiAgICAgIGxvZ2dlci5lcnJvcihbXG4gICAgICAgIGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkobmFtZSl9IGhhcyBhbiBpbmNvbXBhdGlibGUgcGVlciBkZXBlbmRlbmN5IHRvYCxcbiAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkocGVlcil9IChyZXF1aXJlcyAke0pTT04uc3RyaW5naWZ5KHJhbmdlKX0sYCxcbiAgICAgICAgYHdvdWxkIGluc3RhbGwgJHtKU09OLnN0cmluZ2lmeShwZWVyVmVyc2lvbil9KWAsXG4gICAgICBdLmpvaW4oJyAnKSk7XG5cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuXG5mdW5jdGlvbiBfdmFsaWRhdGVSZXZlcnNlUGVlckRlcGVuZGVuY2llcyhcbiAgbmFtZTogc3RyaW5nLFxuICB2ZXJzaW9uOiBzdHJpbmcsXG4gIGluZm9NYXA6IE1hcDxzdHJpbmcsIFBhY2thZ2VJbmZvPixcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbikge1xuICBmb3IgKGNvbnN0IFtpbnN0YWxsZWQsIGluc3RhbGxlZEluZm9dIG9mIGluZm9NYXAuZW50cmllcygpKSB7XG4gICAgY29uc3QgaW5zdGFsbGVkTG9nZ2VyID0gbG9nZ2VyLmNyZWF0ZUNoaWxkKGluc3RhbGxlZCk7XG4gICAgaW5zdGFsbGVkTG9nZ2VyLmRlYnVnKGAke2luc3RhbGxlZH0uLi5gKTtcbiAgICBjb25zdCBwZWVycyA9IChpbnN0YWxsZWRJbmZvLnRhcmdldCB8fCBpbnN0YWxsZWRJbmZvLmluc3RhbGxlZCkucGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llcztcblxuICAgIGZvciAoY29uc3QgW3BlZXIsIHJhbmdlXSBvZiBPYmplY3QuZW50cmllcyhwZWVycyB8fCB7fSkpIHtcbiAgICAgIGlmIChwZWVyICE9IG5hbWUpIHtcbiAgICAgICAgLy8gT25seSBjaGVjayBwZWVycyB0byB0aGUgcGFja2FnZXMgd2UncmUgdXBkYXRpbmcuIFdlIGRvbid0IGNhcmUgYWJvdXQgcGVlcnNcbiAgICAgICAgLy8gdGhhdCBhcmUgdW5tZXQgYnV0IHdlIGhhdmUgbm8gZWZmZWN0IG9uLlxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFzZW12ZXIuc2F0aXNmaWVzKHZlcnNpb24sIHJhbmdlKSkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoW1xuICAgICAgICAgIGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkoaW5zdGFsbGVkKX0gaGFzIGFuIGluY29tcGF0aWJsZSBwZWVyIGRlcGVuZGVuY3kgdG9gLFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KG5hbWUpfSAocmVxdWlyZXMgJHtKU09OLnN0cmluZ2lmeShyYW5nZSl9LGAsXG4gICAgICAgICAgYHdvdWxkIGluc3RhbGwgJHtKU09OLnN0cmluZ2lmeSh2ZXJzaW9uKX0pLmAsXG4gICAgICAgIF0uam9pbignICcpKTtcblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIF92YWxpZGF0ZVVwZGF0ZVBhY2thZ2VzKFxuICBpbmZvTWFwOiBNYXA8c3RyaW5nLCBQYWNrYWdlSW5mbz4sXG4gIGZvcmNlOiBib29sZWFuLFxuICBsb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuKTogdm9pZCB7XG4gIGxvZ2dlci5kZWJ1ZygnVXBkYXRpbmcgdGhlIGZvbGxvd2luZyBwYWNrYWdlczonKTtcbiAgaW5mb01hcC5mb3JFYWNoKGluZm8gPT4ge1xuICAgIGlmIChpbmZvLnRhcmdldCkge1xuICAgICAgbG9nZ2VyLmRlYnVnKGAgICR7aW5mby5uYW1lfSA9PiAke2luZm8udGFyZ2V0LnZlcnNpb259YCk7XG4gICAgfVxuICB9KTtcblxuICBsZXQgcGVlckVycm9ycyA9IGZhbHNlO1xuICBpbmZvTWFwLmZvckVhY2goaW5mbyA9PiB7XG4gICAgY29uc3Qge25hbWUsIHRhcmdldH0gPSBpbmZvO1xuICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcGtnTG9nZ2VyID0gbG9nZ2VyLmNyZWF0ZUNoaWxkKG5hbWUpO1xuICAgIGxvZ2dlci5kZWJ1ZyhgJHtuYW1lfS4uLmApO1xuXG4gICAgY29uc3QgcGVlcnMgPSB0YXJnZXQucGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llcyB8fCB7fTtcbiAgICBwZWVyRXJyb3JzID0gX3ZhbGlkYXRlRm9yd2FyZFBlZXJEZXBlbmRlbmNpZXMobmFtZSwgaW5mb01hcCwgcGVlcnMsIHBrZ0xvZ2dlcikgfHwgcGVlckVycm9ycztcbiAgICBwZWVyRXJyb3JzXG4gICAgICA9IF92YWxpZGF0ZVJldmVyc2VQZWVyRGVwZW5kZW5jaWVzKG5hbWUsIHRhcmdldC52ZXJzaW9uLCBpbmZvTWFwLCBwa2dMb2dnZXIpXG4gICAgICB8fCBwZWVyRXJyb3JzO1xuICB9KTtcblxuICBpZiAoIWZvcmNlICYmIHBlZXJFcnJvcnMpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbihgSW5jb21wYXRpYmxlIHBlZXIgZGVwZW5kZW5jaWVzIGZvdW5kLiBTZWUgYWJvdmUuYCk7XG4gIH1cbn1cblxuXG5mdW5jdGlvbiBfcGVyZm9ybVVwZGF0ZShcbiAgdHJlZTogVHJlZSxcbiAgY29udGV4dDogU2NoZW1hdGljQ29udGV4dCxcbiAgaW5mb01hcDogTWFwPHN0cmluZywgUGFja2FnZUluZm8+LFxuICBsb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuKTogT2JzZXJ2YWJsZTx2b2lkPiB7XG4gIGNvbnN0IHBhY2thZ2VKc29uQ29udGVudCA9IHRyZWUucmVhZCgnL3BhY2thZ2UuanNvbicpO1xuICBpZiAoIXBhY2thZ2VKc29uQ29udGVudCkge1xuICAgIHRocm93IG5ldyBTY2hlbWF0aWNzRXhjZXB0aW9uKCdDb3VsZCBub3QgZmluZCBhIHBhY2thZ2UuanNvbi4gQXJlIHlvdSBpbiBhIE5vZGUgcHJvamVjdD8nKTtcbiAgfVxuXG4gIGxldCBwYWNrYWdlSnNvbjogSnNvblNjaGVtYUZvck5wbVBhY2thZ2VKc29uRmlsZXM7XG4gIHRyeSB7XG4gICAgcGFja2FnZUpzb24gPSBKU09OLnBhcnNlKHBhY2thZ2VKc29uQ29udGVudC50b1N0cmluZygpKSBhcyBKc29uU2NoZW1hRm9yTnBtUGFja2FnZUpzb25GaWxlcztcbiAgfSBjYXRjaCAoZSkge1xuICAgIHRocm93IG5ldyBTY2hlbWF0aWNzRXhjZXB0aW9uKCdwYWNrYWdlLmpzb24gY291bGQgbm90IGJlIHBhcnNlZDogJyArIGUubWVzc2FnZSk7XG4gIH1cblxuICBjb25zdCB0b0luc3RhbGwgPSBbLi4uaW5mb01hcC52YWx1ZXMoKV1cbiAgICAgIC5tYXAoeCA9PiBbeC5uYW1lLCB4LnRhcmdldCwgeC5pbnN0YWxsZWRdKVxuICAgICAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOm5vbi1udWxsLW9wZXJhdG9yXG4gICAgICAuZmlsdGVyKChbbmFtZSwgdGFyZ2V0LCBpbnN0YWxsZWRdKSA9PiB7XG4gICAgICAgIHJldHVybiAhIW5hbWUgJiYgISF0YXJnZXQgJiYgISFpbnN0YWxsZWQ7XG4gICAgICB9KSBhcyBbc3RyaW5nLCBQYWNrYWdlVmVyc2lvbkluZm8sIFBhY2thZ2VWZXJzaW9uSW5mb11bXTtcblxuICB0b0luc3RhbGwuZm9yRWFjaCgoW25hbWUsIHRhcmdldCwgaW5zdGFsbGVkXSkgPT4ge1xuICAgIGxvZ2dlci5pbmZvKFxuICAgICAgYFVwZGF0aW5nIHBhY2thZ2UuanNvbiB3aXRoIGRlcGVuZGVuY3kgJHtuYW1lfSBgXG4gICAgICArIGBAICR7SlNPTi5zdHJpbmdpZnkodGFyZ2V0LnZlcnNpb24pfSAod2FzICR7SlNPTi5zdHJpbmdpZnkoaW5zdGFsbGVkLnZlcnNpb24pfSkuLi5gLFxuICAgICk7XG5cbiAgICBpZiAocGFja2FnZUpzb24uZGVwZW5kZW5jaWVzICYmIHBhY2thZ2VKc29uLmRlcGVuZGVuY2llc1tuYW1lXSkge1xuICAgICAgcGFja2FnZUpzb24uZGVwZW5kZW5jaWVzW25hbWVdID0gdGFyZ2V0LnZlcnNpb247XG5cbiAgICAgIGlmIChwYWNrYWdlSnNvbi5kZXZEZXBlbmRlbmNpZXMgJiYgcGFja2FnZUpzb24uZGV2RGVwZW5kZW5jaWVzW25hbWVdKSB7XG4gICAgICAgIGRlbGV0ZSBwYWNrYWdlSnNvbi5kZXZEZXBlbmRlbmNpZXNbbmFtZV07XG4gICAgICB9XG4gICAgICBpZiAocGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llcyAmJiBwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzW25hbWVdKSB7XG4gICAgICAgIGRlbGV0ZSBwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzW25hbWVdO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAocGFja2FnZUpzb24uZGV2RGVwZW5kZW5jaWVzICYmIHBhY2thZ2VKc29uLmRldkRlcGVuZGVuY2llc1tuYW1lXSkge1xuICAgICAgcGFja2FnZUpzb24uZGV2RGVwZW5kZW5jaWVzW25hbWVdID0gdGFyZ2V0LnZlcnNpb247XG5cbiAgICAgIGlmIChwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzICYmIHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXNbbmFtZV0pIHtcbiAgICAgICAgZGVsZXRlIHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXNbbmFtZV07XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzICYmIHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXNbbmFtZV0pIHtcbiAgICAgIHBhY2thZ2VKc29uLnBlZXJEZXBlbmRlbmNpZXNbbmFtZV0gPSB0YXJnZXQudmVyc2lvbjtcbiAgICB9IGVsc2Uge1xuICAgICAgbG9nZ2VyLndhcm4oYFBhY2thZ2UgJHtuYW1lfSB3YXMgbm90IGZvdW5kIGluIGRlcGVuZGVuY2llcy5gKTtcbiAgICB9XG4gIH0pO1xuXG4gIGNvbnN0IG5ld0NvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShwYWNrYWdlSnNvbiwgbnVsbCwgMik7XG4gIGlmIChwYWNrYWdlSnNvbkNvbnRlbnQudG9TdHJpbmcoKSAhPSBuZXdDb250ZW50KSB7XG4gICAgLy8gSWYgc29tZXRoaW5nIGNoYW5nZWQsIGFsc28gaG9vayB1cCB0aGUgdGFzay5cbiAgICB0cmVlLm92ZXJ3cml0ZSgnL3BhY2thZ2UuanNvbicsIEpTT04uc3RyaW5naWZ5KHBhY2thZ2VKc29uLCBudWxsLCAyKSk7XG4gICAgY29uc3QgaW5zdGFsbFRhc2sgPSBjb250ZXh0LmFkZFRhc2sobmV3IE5vZGVQYWNrYWdlSW5zdGFsbFRhc2soKSk7XG5cbiAgICAvLyBSdW4gdGhlIG1pZ3JhdGUgc2NoZW1hdGljcyB3aXRoIHRoZSBsaXN0IG9mIHBhY2thZ2VzIHRvIHVzZS4gVGhlIGNvbGxlY3Rpb24gY29udGFpbnNcbiAgICAvLyB2ZXJzaW9uIGluZm9ybWF0aW9uIGFuZCB3ZSBuZWVkIHRvIGRvIHRoaXMgcG9zdCBpbnN0YWxsYXRpb24uIFBsZWFzZSBub3RlIHRoYXQgdGhlXG4gICAgLy8gbWlncmF0aW9uIENPVUxEIGZhaWwgYW5kIGxlYXZlIHNpZGUgZWZmZWN0cyBvbiBkaXNrLlxuICAgIC8vIFJ1biB0aGUgc2NoZW1hdGljcyB0YXNrIG9mIHRob3NlIHBhY2thZ2VzLlxuICAgIHRvSW5zdGFsbC5mb3JFYWNoKChbbmFtZSwgdGFyZ2V0LCBpbnN0YWxsZWRdKSA9PiB7XG4gICAgICBpZiAoIXRhcmdldC51cGRhdGVNZXRhZGF0YS5taWdyYXRpb25zKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY29sbGVjdGlvbiA9IChcbiAgICAgICAgdGFyZ2V0LnVwZGF0ZU1ldGFkYXRhLm1pZ3JhdGlvbnMubWF0Y2goL15bLi9dLylcbiAgICAgICAgPyBuYW1lICsgJy8nXG4gICAgICAgIDogJydcbiAgICAgICkgKyB0YXJnZXQudXBkYXRlTWV0YWRhdGEubWlncmF0aW9ucztcblxuICAgICAgY29udGV4dC5hZGRUYXNrKG5ldyBSdW5TY2hlbWF0aWNUYXNrKCdAc2NoZW1hdGljcy91cGRhdGUnLCAnbWlncmF0ZScsIHtcbiAgICAgICAgICBwYWNrYWdlOiBuYW1lLFxuICAgICAgICAgIGNvbGxlY3Rpb24sXG4gICAgICAgICAgZnJvbTogaW5zdGFsbGVkLnZlcnNpb24sXG4gICAgICAgICAgdG86IHRhcmdldC52ZXJzaW9uLFxuICAgICAgICB9KSxcbiAgICAgICAgW2luc3RhbGxUYXNrXSxcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gb2Y8dm9pZD4odW5kZWZpbmVkKTtcbn1cblxuXG5mdW5jdGlvbiBfZ2V0VXBkYXRlTWV0YWRhdGEoXG4gIHBhY2thZ2VKc29uOiBKc29uU2NoZW1hRm9yTnBtUGFja2FnZUpzb25GaWxlcyxcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IFVwZGF0ZU1ldGFkYXRhIHtcbiAgY29uc3QgbWV0YWRhdGEgPSBwYWNrYWdlSnNvblsnbmctdXBkYXRlJ107XG5cbiAgY29uc3QgcmVzdWx0OiBVcGRhdGVNZXRhZGF0YSA9IHtcbiAgICBwYWNrYWdlR3JvdXA6IFtdLFxuICAgIHJlcXVpcmVtZW50czoge30sXG4gIH07XG5cbiAgaWYgKCFtZXRhZGF0YSB8fCB0eXBlb2YgbWV0YWRhdGEgIT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShtZXRhZGF0YSkpIHtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgaWYgKG1ldGFkYXRhWydwYWNrYWdlR3JvdXAnXSkge1xuICAgIGNvbnN0IHBhY2thZ2VHcm91cCA9IG1ldGFkYXRhWydwYWNrYWdlR3JvdXAnXTtcbiAgICAvLyBWZXJpZnkgdGhhdCBwYWNrYWdlR3JvdXAgaXMgYW4gYXJyYXkgb2Ygc3RyaW5ncy4gVGhpcyBpcyBub3QgYW4gZXJyb3IgYnV0IHdlIHN0aWxsIHdhcm5cbiAgICAvLyB0aGUgdXNlciBhbmQgaWdub3JlIHRoZSBwYWNrYWdlR3JvdXAga2V5cy5cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocGFja2FnZUdyb3VwKSB8fCBwYWNrYWdlR3JvdXAuc29tZSh4ID0+IHR5cGVvZiB4ICE9ICdzdHJpbmcnKSkge1xuICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgIGBwYWNrYWdlR3JvdXAgbWV0YWRhdGEgb2YgcGFja2FnZSAke3BhY2thZ2VKc29uLm5hbWV9IGlzIG1hbGZvcm1lZC4gSWdub3JpbmcuYCxcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdC5wYWNrYWdlR3JvdXAgPSBwYWNrYWdlR3JvdXA7XG4gICAgfVxuICB9XG5cbiAgaWYgKG1ldGFkYXRhWydyZXF1aXJlbWVudHMnXSkge1xuICAgIGNvbnN0IHJlcXVpcmVtZW50cyA9IG1ldGFkYXRhWydyZXF1aXJlbWVudHMnXTtcbiAgICAvLyBWZXJpZnkgdGhhdCByZXF1aXJlbWVudHMgYXJlXG4gICAgaWYgKHR5cGVvZiByZXF1aXJlbWVudHMgIT0gJ29iamVjdCdcbiAgICAgICAgfHwgQXJyYXkuaXNBcnJheShyZXF1aXJlbWVudHMpXG4gICAgICAgIHx8IE9iamVjdC5rZXlzKHJlcXVpcmVtZW50cykuc29tZShuYW1lID0+IHR5cGVvZiByZXF1aXJlbWVudHNbbmFtZV0gIT0gJ3N0cmluZycpKSB7XG4gICAgICBsb2dnZXIud2FybihcbiAgICAgICAgYHJlcXVpcmVtZW50cyBtZXRhZGF0YSBvZiBwYWNrYWdlICR7cGFja2FnZUpzb24ubmFtZX0gaXMgbWFsZm9ybWVkLiBJZ25vcmluZy5gLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0LnJlcXVpcmVtZW50cyA9IHJlcXVpcmVtZW50cztcbiAgICB9XG4gIH1cblxuICBpZiAobWV0YWRhdGFbJ21pZ3JhdGlvbnMnXSkge1xuICAgIGNvbnN0IG1pZ3JhdGlvbnMgPSBtZXRhZGF0YVsnbWlncmF0aW9ucyddO1xuICAgIGlmICh0eXBlb2YgbWlncmF0aW9ucyAhPSAnc3RyaW5nJykge1xuICAgICAgbG9nZ2VyLndhcm4oYG1pZ3JhdGlvbnMgbWV0YWRhdGEgb2YgcGFja2FnZSAke3BhY2thZ2VKc29uLm5hbWV9IGlzIG1hbGZvcm1lZC4gSWdub3JpbmcuYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdC5taWdyYXRpb25zID0gbWlncmF0aW9ucztcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5cbmZ1bmN0aW9uIF91c2FnZU1lc3NhZ2UoXG4gIG9wdGlvbnM6IFVwZGF0ZVNjaGVtYSxcbiAgaW5mb01hcDogTWFwPHN0cmluZywgUGFja2FnZUluZm8+LFxuICBsb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuKSB7XG4gIGxvZ2dlci5pbmZvKFxuICAgICdXZSBhbmFseXplZCB5b3VyIHBhY2thZ2UuanNvbiwgdGhlcmUgYXJlIHNvbWUgcGFja2FnZXMgdG8gdXBkYXRlOlxcbicsXG4gICk7XG5cbiAgLy8gRmluZCB0aGUgbGFyZ2VzdCBuYW1lIHRvIGtub3cgdGhlIHBhZGRpbmcgbmVlZGVkLlxuICBsZXQgbmFtZVBhZCA9IE1hdGgubWF4KC4uLlsuLi5pbmZvTWFwLmtleXMoKV0ubWFwKHggPT4geC5sZW5ndGgpKSArIDI7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKG5hbWVQYWQpKSB7XG4gICAgbmFtZVBhZCA9IDMwO1xuICB9XG5cbiAgbG9nZ2VyLmluZm8oXG4gICAgJyAgJ1xuICAgICsgJ05hbWUnLnBhZEVuZChuYW1lUGFkKVxuICAgICsgJ1ZlcnNpb24nLnBhZEVuZCgyNSlcbiAgICArICcgIENvbW1hbmQgdG8gdXBkYXRlJyxcbiAgKTtcbiAgbG9nZ2VyLmluZm8oJyAnICsgJy0nLnJlcGVhdChuYW1lUGFkICogMiArIDM1KSk7XG5cbiAgWy4uLmluZm9NYXAuZW50cmllcygpXS5zb3J0KCkuZm9yRWFjaCgoW25hbWUsIGluZm9dKSA9PiB7XG4gICAgY29uc3QgdGFnID0gb3B0aW9ucy5uZXh0ID8gJ25leHQnIDogJ2xhdGVzdCc7XG4gICAgY29uc3QgdmVyc2lvbiA9IGluZm8ubnBtUGFja2FnZUpzb25bJ2Rpc3QtdGFncyddW3RhZ107XG4gICAgY29uc3QgdGFyZ2V0ID0gaW5mby5ucG1QYWNrYWdlSnNvbi52ZXJzaW9uc1t2ZXJzaW9uXTtcblxuICAgIGlmICh0YXJnZXQgJiYgc2VtdmVyLmNvbXBhcmUoaW5mby5pbnN0YWxsZWQudmVyc2lvbiwgdmVyc2lvbikgPCAwKSB7XG4gICAgICBsZXQgY29tbWFuZCA9IGBucG0gaW5zdGFsbCAke25hbWV9YDtcbiAgICAgIGlmICh0YXJnZXQgJiYgdGFyZ2V0WyduZy11cGRhdGUnXSkge1xuICAgICAgICAvLyBTaG93IHRoZSBuZyBjb21tYW5kIG9ubHkgd2hlbiBtaWdyYXRpb25zIGFyZSBzdXBwb3J0ZWQsIG90aGVyd2lzZSBpdCdzIGEgZmFuY3lcbiAgICAgICAgLy8gbnBtIGluc3RhbGwsIHJlYWxseS5cbiAgICAgICAgY29tbWFuZCA9IGBuZyB1cGRhdGUgJHtuYW1lfWA7XG4gICAgICB9XG5cbiAgICAgIGxvZ2dlci5pbmZvKFxuICAgICAgICAnICAnXG4gICAgICAgICsgbmFtZS5wYWRFbmQobmFtZVBhZClcbiAgICAgICAgKyBgJHtpbmZvLmluc3RhbGxlZC52ZXJzaW9ufSAtPiAke3ZlcnNpb259YC5wYWRFbmQoMjUpXG4gICAgICAgICsgJyAgJyArIGNvbW1hbmQsXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG5cbiAgbG9nZ2VyLmluZm8oJ1xcbicpO1xuICBsb2dnZXIuaW5mbygnVGhlcmUgbWlnaHQgYmUgYWRkaXRpb25hbCBwYWNrYWdlcyB0aGF0IGFyZSBvdXRkYXRlZC4nKTtcbiAgbG9nZ2VyLmluZm8oJ09yIHJ1biBuZyB1cGRhdGUgLS1hbGwgdG8gdHJ5IHRvIHVwZGF0ZSBhbGwgYXQgdGhlIHNhbWUgdGltZS5cXG4nKTtcblxuICByZXR1cm4gb2Y8dm9pZD4odW5kZWZpbmVkKTtcbn1cblxuXG5mdW5jdGlvbiBfYnVpbGRQYWNrYWdlSW5mbyhcbiAgdHJlZTogVHJlZSxcbiAgcGFja2FnZXM6IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4sXG4gIGFsbERlcGVuZGVuY2llczogTWFwPHN0cmluZywgVmVyc2lvblJhbmdlPixcbiAgbnBtUGFja2FnZUpzb246IE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbixcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IFBhY2thZ2VJbmZvIHtcbiAgY29uc3QgbmFtZSA9IG5wbVBhY2thZ2VKc29uLm5hbWU7XG4gIGNvbnN0IHBhY2thZ2VKc29uUmFuZ2UgPSBhbGxEZXBlbmRlbmNpZXMuZ2V0KG5hbWUpO1xuICBpZiAoIXBhY2thZ2VKc29uUmFuZ2UpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbihcbiAgICAgIGBQYWNrYWdlICR7SlNPTi5zdHJpbmdpZnkobmFtZSl9IHdhcyBub3QgZm91bmQgaW4gcGFja2FnZS5qc29uLmAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIEZpbmQgb3V0IHRoZSBjdXJyZW50bHkgaW5zdGFsbGVkIHZlcnNpb24uIEVpdGhlciBmcm9tIHRoZSBwYWNrYWdlLmpzb24gb3IgdGhlIG5vZGVfbW9kdWxlcy9cbiAgLy8gVE9ETzogZmlndXJlIG91dCBhIHdheSB0byByZWFkIHBhY2thZ2UtbG9jay5qc29uIGFuZC9vciB5YXJuLmxvY2suXG4gIGxldCBpbnN0YWxsZWRWZXJzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHBhY2thZ2VDb250ZW50ID0gdHJlZS5yZWFkKGAvbm9kZV9tb2R1bGVzLyR7bmFtZX0vcGFja2FnZS5qc29uYCk7XG4gIGlmIChwYWNrYWdlQ29udGVudCkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBKU09OLnBhcnNlKHBhY2thZ2VDb250ZW50LnRvU3RyaW5nKCkpIGFzIEpzb25TY2hlbWFGb3JOcG1QYWNrYWdlSnNvbkZpbGVzO1xuICAgIGluc3RhbGxlZFZlcnNpb24gPSBjb250ZW50LnZlcnNpb247XG4gIH1cbiAgaWYgKCFpbnN0YWxsZWRWZXJzaW9uKSB7XG4gICAgLy8gRmluZCB0aGUgdmVyc2lvbiBmcm9tIE5QTSB0aGF0IGZpdHMgdGhlIHJhbmdlIHRvIG1heC5cbiAgICBpbnN0YWxsZWRWZXJzaW9uID0gc2VtdmVyLm1heFNhdGlzZnlpbmcoXG4gICAgICBPYmplY3Qua2V5cyhucG1QYWNrYWdlSnNvbi52ZXJzaW9ucyksXG4gICAgICBwYWNrYWdlSnNvblJhbmdlLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBpbnN0YWxsZWRQYWNrYWdlSnNvbiA9IG5wbVBhY2thZ2VKc29uLnZlcnNpb25zW2luc3RhbGxlZFZlcnNpb25dIHx8IHBhY2thZ2VDb250ZW50O1xuICBpZiAoIWluc3RhbGxlZFBhY2thZ2VKc29uKSB7XG4gICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oXG4gICAgICBgQW4gdW5leHBlY3RlZCBlcnJvciBoYXBwZW5lZDsgcGFja2FnZSAke25hbWV9IGhhcyBubyB2ZXJzaW9uICR7aW5zdGFsbGVkVmVyc2lvbn0uYCxcbiAgICApO1xuICB9XG5cbiAgbGV0IHRhcmdldFZlcnNpb246IFZlcnNpb25SYW5nZSB8IHVuZGVmaW5lZCA9IHBhY2thZ2VzLmdldChuYW1lKTtcbiAgaWYgKHRhcmdldFZlcnNpb24pIHtcbiAgICBpZiAobnBtUGFja2FnZUpzb25bJ2Rpc3QtdGFncyddW3RhcmdldFZlcnNpb25dKSB7XG4gICAgICB0YXJnZXRWZXJzaW9uID0gbnBtUGFja2FnZUpzb25bJ2Rpc3QtdGFncyddW3RhcmdldFZlcnNpb25dIGFzIFZlcnNpb25SYW5nZTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGFyZ2V0VmVyc2lvbiA9IHNlbXZlci5tYXhTYXRpc2Z5aW5nKFxuICAgICAgICBPYmplY3Qua2V5cyhucG1QYWNrYWdlSnNvbi52ZXJzaW9ucyksXG4gICAgICAgIHRhcmdldFZlcnNpb24sXG4gICAgICApIGFzIFZlcnNpb25SYW5nZTtcbiAgICB9XG4gIH1cblxuICBpZiAodGFyZ2V0VmVyc2lvbiAmJiBzZW12ZXIubHRlKHRhcmdldFZlcnNpb24sIGluc3RhbGxlZFZlcnNpb24pKSB7XG4gICAgbG9nZ2VyLmRlYnVnKGBQYWNrYWdlICR7bmFtZX0gYWxyZWFkeSBzYXRpc2ZpZWQgYnkgcGFja2FnZS5qc29uICgke3BhY2thZ2VKc29uUmFuZ2V9KS5gKTtcbiAgICB0YXJnZXRWZXJzaW9uID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgY29uc3QgdGFyZ2V0OiBQYWNrYWdlVmVyc2lvbkluZm8gfCB1bmRlZmluZWQgPSB0YXJnZXRWZXJzaW9uXG4gICAgPyB7XG4gICAgICB2ZXJzaW9uOiB0YXJnZXRWZXJzaW9uLFxuICAgICAgcGFja2FnZUpzb246IG5wbVBhY2thZ2VKc29uLnZlcnNpb25zW3RhcmdldFZlcnNpb25dLFxuICAgICAgdXBkYXRlTWV0YWRhdGE6IF9nZXRVcGRhdGVNZXRhZGF0YShucG1QYWNrYWdlSnNvbi52ZXJzaW9uc1t0YXJnZXRWZXJzaW9uXSwgbG9nZ2VyKSxcbiAgICB9XG4gICAgOiB1bmRlZmluZWQ7XG5cbiAgLy8gQ2hlY2sgaWYgdGhlcmUncyBhbiBpbnN0YWxsZWQgdmVyc2lvbi5cbiAgcmV0dXJuIHtcbiAgICBuYW1lLFxuICAgIG5wbVBhY2thZ2VKc29uLFxuICAgIGluc3RhbGxlZDoge1xuICAgICAgdmVyc2lvbjogaW5zdGFsbGVkVmVyc2lvbiBhcyBWZXJzaW9uUmFuZ2UsXG4gICAgICBwYWNrYWdlSnNvbjogaW5zdGFsbGVkUGFja2FnZUpzb24sXG4gICAgICB1cGRhdGVNZXRhZGF0YTogX2dldFVwZGF0ZU1ldGFkYXRhKGluc3RhbGxlZFBhY2thZ2VKc29uLCBsb2dnZXIpLFxuICAgIH0sXG4gICAgdGFyZ2V0LFxuICAgIHBhY2thZ2VKc29uUmFuZ2UsXG4gIH07XG59XG5cblxuZnVuY3Rpb24gX2J1aWxkUGFja2FnZUxpc3QoXG4gIG9wdGlvbnM6IFVwZGF0ZVNjaGVtYSxcbiAgcHJvamVjdERlcHM6IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4sXG4gIGxvZ2dlcjogbG9nZ2luZy5Mb2dnZXJBcGksXG4pOiBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+IHtcbiAgLy8gUGFyc2UgdGhlIHBhY2thZ2VzIG9wdGlvbnMgdG8gc2V0IHRoZSB0YXJnZXRlZCB2ZXJzaW9uLlxuICBjb25zdCBwYWNrYWdlcyA9IG5ldyBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+KCk7XG4gIGNvbnN0IGNvbW1hbmRMaW5lUGFja2FnZXMgPVxuICAgIChvcHRpb25zLnBhY2thZ2VzICYmIG9wdGlvbnMucGFja2FnZXMubGVuZ3RoID4gMClcbiAgICA/IG9wdGlvbnMucGFja2FnZXNcbiAgICA6IChvcHRpb25zLmFsbCA/IHByb2plY3REZXBzLmtleXMoKSA6IFtdKTtcblxuICBmb3IgKGNvbnN0IHBrZyBvZiBjb21tYW5kTGluZVBhY2thZ2VzKSB7XG4gICAgLy8gU3BsaXQgdGhlIHZlcnNpb24gYXNrZWQgb24gY29tbWFuZCBsaW5lLlxuICAgIGNvbnN0IG0gPSBwa2cubWF0Y2goL14oKD86QFteL117MSwxMDB9XFwvKT9bXkBdezEsMTAwfSkoPzpAKC57MSwxMDB9KSk/JC8pO1xuICAgIGlmICghbSkge1xuICAgICAgbG9nZ2VyLndhcm4oYEludmFsaWQgcGFja2FnZSBhcmd1bWVudDogJHtKU09OLnN0cmluZ2lmeShwa2cpfS4gU2tpcHBpbmcuYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBbLCBucG1OYW1lLCBtYXliZVZlcnNpb25dID0gbTtcblxuICAgIGNvbnN0IHZlcnNpb24gPSBwcm9qZWN0RGVwcy5nZXQobnBtTmFtZSk7XG4gICAgaWYgKCF2ZXJzaW9uKSB7XG4gICAgICBsb2dnZXIud2FybihgUGFja2FnZSBub3QgaW5zdGFsbGVkOiAke0pTT04uc3RyaW5naWZ5KG5wbU5hbWUpfS4gU2tpcHBpbmcuYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBWZXJpZnkgdGhhdCBwZW9wbGUgaGF2ZSBhbiBhY3R1YWwgdmVyc2lvbiBpbiB0aGUgcGFja2FnZS5qc29uLCBvdGhlcndpc2UgKGxhYmVsIG9yIFVSTCBvclxuICAgIC8vIGdpc3Qgb3IgLi4uKSB3ZSBkb24ndCB1cGRhdGUgaXQuXG4gICAgaWYgKFxuICAgICAgdmVyc2lvbi5zdGFydHNXaXRoKCdodHRwOicpICAvLyBIVFRQXG4gICAgICB8fCB2ZXJzaW9uLnN0YXJ0c1dpdGgoJ2ZpbGU6JykgIC8vIExvY2FsIGZvbGRlclxuICAgICAgfHwgdmVyc2lvbi5zdGFydHNXaXRoKCdnaXQ6JykgIC8vIEdJVCB1cmxcbiAgICAgIHx8IHZlcnNpb24ubWF0Y2goL15cXHd7MSwxMDB9XFwvXFx3ezEsMTAwfS8pICAvLyBHaXRIdWIncyBcInVzZXIvcmVwb1wiXG4gICAgICB8fCB2ZXJzaW9uLm1hdGNoKC9eKD86XFwuezAsMn1cXC8pXFx3ezEsMTAwfS8pICAvLyBMb2NhbCBmb2xkZXIsIG1heWJlIHJlbGF0aXZlLlxuICAgICkge1xuICAgICAgLy8gV2Ugb25seSBkbyB0aGF0IGZvciAtLWFsbC4gT3RoZXJ3aXNlIHdlIGhhdmUgdGhlIGluc3RhbGxlZCB2ZXJzaW9uIGFuZCB0aGUgdXNlciBzcGVjaWZpZWRcbiAgICAgIC8vIGl0IG9uIHRoZSBjb21tYW5kIGxpbmUuXG4gICAgICBpZiAob3B0aW9ucy5hbGwpIHtcbiAgICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgICAgYFBhY2thZ2UgJHtKU09OLnN0cmluZ2lmeShucG1OYW1lKX0gaGFzIGEgY3VzdG9tIHZlcnNpb246IGBcbiAgICAgICAgICArIGAke0pTT04uc3RyaW5naWZ5KHZlcnNpb24pfS4gU2tpcHBpbmcuYCxcbiAgICAgICAgKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcGFja2FnZXMuc2V0KG5wbU5hbWUsIChtYXliZVZlcnNpb24gfHwgKG9wdGlvbnMubmV4dCA/ICduZXh0JyA6ICdsYXRlc3QnKSkgYXMgVmVyc2lvblJhbmdlKTtcbiAgfVxuXG4gIHJldHVybiBwYWNrYWdlcztcbn1cblxuXG5mdW5jdGlvbiBfYWRkUGFja2FnZUdyb3VwKFxuICBwYWNrYWdlczogTWFwPHN0cmluZywgVmVyc2lvblJhbmdlPixcbiAgYWxsRGVwZW5kZW5jaWVzOiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz4sXG4gIG5wbVBhY2thZ2VKc29uOiBOcG1SZXBvc2l0b3J5UGFja2FnZUpzb24sXG4gIGxvZ2dlcjogbG9nZ2luZy5Mb2dnZXJBcGksXG4pOiB2b2lkIHtcbiAgY29uc3QgbWF5YmVQYWNrYWdlID0gcGFja2FnZXMuZ2V0KG5wbVBhY2thZ2VKc29uLm5hbWUpO1xuICBpZiAoIW1heWJlUGFja2FnZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHZlcnNpb24gPSBucG1QYWNrYWdlSnNvblsnZGlzdC10YWdzJ11bbWF5YmVQYWNrYWdlXSB8fCBtYXliZVBhY2thZ2U7XG4gIGlmICghbnBtUGFja2FnZUpzb24udmVyc2lvbnNbdmVyc2lvbl0pIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbmdVcGRhdGVNZXRhZGF0YSA9IG5wbVBhY2thZ2VKc29uLnZlcnNpb25zW3ZlcnNpb25dWyduZy11cGRhdGUnXTtcbiAgaWYgKCFuZ1VwZGF0ZU1ldGFkYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcGFja2FnZUdyb3VwID0gbmdVcGRhdGVNZXRhZGF0YVsncGFja2FnZUdyb3VwJ107XG4gIGlmICghcGFja2FnZUdyb3VwKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghQXJyYXkuaXNBcnJheShwYWNrYWdlR3JvdXApIHx8IHBhY2thZ2VHcm91cC5zb21lKHggPT4gdHlwZW9mIHggIT0gJ3N0cmluZycpKSB7XG4gICAgbG9nZ2VyLndhcm4oYHBhY2thZ2VHcm91cCBtZXRhZGF0YSBvZiBwYWNrYWdlICR7bnBtUGFja2FnZUpzb24ubmFtZX0gaXMgbWFsZm9ybWVkLmApO1xuXG4gICAgcmV0dXJuO1xuICB9XG5cbiAgcGFja2FnZUdyb3VwXG4gICAgLmZpbHRlcihuYW1lID0+ICFwYWNrYWdlcy5oYXMobmFtZSkpICAvLyBEb24ndCBvdmVycmlkZSBuYW1lcyBmcm9tIHRoZSBjb21tYW5kIGxpbmUuXG4gICAgLmZpbHRlcihuYW1lID0+IGFsbERlcGVuZGVuY2llcy5oYXMobmFtZSkpICAvLyBSZW1vdmUgcGFja2FnZXMgdGhhdCBhcmVuJ3QgaW5zdGFsbGVkLlxuICAgIC5mb3JFYWNoKG5hbWUgPT4ge1xuICAgIHBhY2thZ2VzLnNldChuYW1lLCBtYXliZVBhY2thZ2UpO1xuICB9KTtcbn1cblxuLyoqXG4gKiBBZGQgcGVlciBkZXBlbmRlbmNpZXMgb2YgcGFja2FnZXMgb24gdGhlIGNvbW1hbmQgbGluZSB0byB0aGUgbGlzdCBvZiBwYWNrYWdlcyB0byB1cGRhdGUuXG4gKiBXZSBkb24ndCBkbyB2ZXJpZmljYXRpb24gb2YgdGhlIHZlcnNpb25zIGhlcmUgYXMgdGhpcyB3aWxsIGJlIGRvbmUgYnkgYSBsYXRlciBzdGVwIChhbmQgY2FuXG4gKiBiZSBpZ25vcmVkIGJ5IHRoZSAtLWZvcmNlIGZsYWcpLlxuICogQHByaXZhdGVcbiAqL1xuZnVuY3Rpb24gX2FkZFBlZXJEZXBlbmRlbmNpZXMoXG4gIHBhY2thZ2VzOiBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+LFxuICBfYWxsRGVwZW5kZW5jaWVzOiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz4sXG4gIG5wbVBhY2thZ2VKc29uOiBOcG1SZXBvc2l0b3J5UGFja2FnZUpzb24sXG4gIF9sb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IG1heWJlUGFja2FnZSA9IHBhY2thZ2VzLmdldChucG1QYWNrYWdlSnNvbi5uYW1lKTtcbiAgaWYgKCFtYXliZVBhY2thZ2UpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB2ZXJzaW9uID0gbnBtUGFja2FnZUpzb25bJ2Rpc3QtdGFncyddW21heWJlUGFja2FnZV0gfHwgbWF5YmVQYWNrYWdlO1xuICBpZiAoIW5wbVBhY2thZ2VKc29uLnZlcnNpb25zW3ZlcnNpb25dKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcGFja2FnZUpzb24gPSBucG1QYWNrYWdlSnNvbi52ZXJzaW9uc1t2ZXJzaW9uXTtcbiAgY29uc3QgZXJyb3IgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IFtwZWVyLCByYW5nZV0gb2YgT2JqZWN0LmVudHJpZXMocGFja2FnZUpzb24ucGVlckRlcGVuZGVuY2llcyB8fCB7fSkpIHtcbiAgICBpZiAoIXBhY2thZ2VzLmhhcyhwZWVyKSkge1xuICAgICAgcGFja2FnZXMuc2V0KHBlZXIsIHJhbmdlIGFzIFZlcnNpb25SYW5nZSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKGVycm9yKSB7XG4gICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oJ0FuIGVycm9yIG9jY3VyZWQsIHNlZSBhYm92ZS4nKTtcbiAgfVxufVxuXG5cbmZ1bmN0aW9uIF9nZXRBbGxEZXBlbmRlbmNpZXModHJlZTogVHJlZSk6IE1hcDxzdHJpbmcsIFZlcnNpb25SYW5nZT4ge1xuICBjb25zdCBwYWNrYWdlSnNvbkNvbnRlbnQgPSB0cmVlLnJlYWQoJy9wYWNrYWdlLmpzb24nKTtcbiAgaWYgKCFwYWNrYWdlSnNvbkNvbnRlbnQpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbignQ291bGQgbm90IGZpbmQgYSBwYWNrYWdlLmpzb24uIEFyZSB5b3UgaW4gYSBOb2RlIHByb2plY3Q/Jyk7XG4gIH1cblxuICBsZXQgcGFja2FnZUpzb246IEpzb25TY2hlbWFGb3JOcG1QYWNrYWdlSnNvbkZpbGVzO1xuICB0cnkge1xuICAgIHBhY2thZ2VKc29uID0gSlNPTi5wYXJzZShwYWNrYWdlSnNvbkNvbnRlbnQudG9TdHJpbmcoKSkgYXMgSnNvblNjaGVtYUZvck5wbVBhY2thZ2VKc29uRmlsZXM7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbigncGFja2FnZS5qc29uIGNvdWxkIG5vdCBiZSBwYXJzZWQ6ICcgKyBlLm1lc3NhZ2UpO1xuICB9XG5cbiAgcmV0dXJuIG5ldyBNYXA8c3RyaW5nLCBWZXJzaW9uUmFuZ2U+KFtcbiAgICAuLi5PYmplY3QuZW50cmllcyhwYWNrYWdlSnNvbi5wZWVyRGVwZW5kZW5jaWVzIHx8IHt9KSxcbiAgICAuLi5PYmplY3QuZW50cmllcyhwYWNrYWdlSnNvbi5kZXZEZXBlbmRlbmNpZXMgfHwge30pLFxuICAgIC4uLk9iamVjdC5lbnRyaWVzKHBhY2thZ2VKc29uLmRlcGVuZGVuY2llcyB8fCB7fSksXG4gIF0gYXMgW3N0cmluZywgVmVyc2lvblJhbmdlXVtdKTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24ob3B0aW9uczogVXBkYXRlU2NoZW1hKTogUnVsZSB7XG4gIGlmICghb3B0aW9ucy5wYWNrYWdlcykge1xuICAgIC8vIFdlIGNhbm5vdCBqdXN0IHJldHVybiB0aGlzIGJlY2F1c2Ugd2UgbmVlZCB0byBmZXRjaCB0aGUgcGFja2FnZXMgZnJvbSBOUE0gc3RpbGwgZm9yIHRoZVxuICAgIC8vIGhlbHAvZ3VpZGUgdG8gc2hvdy5cbiAgICBvcHRpb25zLnBhY2thZ2VzID0gW107XG4gIH0gZWxzZSBpZiAodHlwZW9mIG9wdGlvbnMucGFja2FnZXMgPT0gJ3N0cmluZycpIHtcbiAgICAvLyBJZiBhIHN0cmluZywgdGhlbiB3ZSBzaG91bGQgc3BsaXQgaXQgYW5kIG1ha2UgaXQgYW4gYXJyYXkuXG4gICAgb3B0aW9ucy5wYWNrYWdlcyA9IG9wdGlvbnMucGFja2FnZXMuc3BsaXQoLywvZyk7XG4gIH1cblxuICByZXR1cm4gKHRyZWU6IFRyZWUsIGNvbnRleHQ6IFNjaGVtYXRpY0NvbnRleHQpID0+IHtcbiAgICBjb25zdCBsb2dnZXIgPSBjb250ZXh0LmxvZ2dlcjtcbiAgICBjb25zdCBhbGxEZXBlbmRlbmNpZXMgPSBfZ2V0QWxsRGVwZW5kZW5jaWVzKHRyZWUpO1xuICAgIGNvbnN0IHBhY2thZ2VzID0gX2J1aWxkUGFja2FnZUxpc3Qob3B0aW9ucywgYWxsRGVwZW5kZW5jaWVzLCBsb2dnZXIpO1xuXG4gICAgcmV0dXJuIG9ic2VydmFibGVGcm9tKFsuLi5hbGxEZXBlbmRlbmNpZXMua2V5cygpXSkucGlwZShcbiAgICAgIC8vIEdyYWIgYWxsIHBhY2thZ2UuanNvbiBmcm9tIHRoZSBucG0gcmVwb3NpdG9yeS4gVGhpcyByZXF1aXJlcyBhIGxvdCBvZiBIVFRQIGNhbGxzIHNvIHdlXG4gICAgICAvLyB0cnkgdG8gcGFyYWxsZWxpemUgYXMgbWFueSBhcyBwb3NzaWJsZS5cbiAgICAgIG1lcmdlTWFwKGRlcE5hbWUgPT4gZ2V0TnBtUGFja2FnZUpzb24oZGVwTmFtZSwgbG9nZ2VyKSksXG5cbiAgICAgIC8vIEJ1aWxkIGEgbWFwIG9mIGFsbCBkZXBlbmRlbmNpZXMgYW5kIHRoZWlyIHBhY2thZ2VKc29uLlxuICAgICAgcmVkdWNlPE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbiwgTWFwPHN0cmluZywgTnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uPj4oXG4gICAgICAgIChhY2MsIG5wbVBhY2thZ2VKc29uKSA9PiBhY2Muc2V0KG5wbVBhY2thZ2VKc29uLm5hbWUsIG5wbVBhY2thZ2VKc29uKSxcbiAgICAgICAgbmV3IE1hcDxzdHJpbmcsIE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbj4oKSxcbiAgICAgICksXG5cbiAgICAgIG1hcChucG1QYWNrYWdlSnNvbk1hcCA9PiB7XG4gICAgICAgIC8vIEF1Z21lbnQgdGhlIGNvbW1hbmQgbGluZSBwYWNrYWdlIGxpc3Qgd2l0aCBwYWNrYWdlR3JvdXBzIGFuZCBmb3J3YXJkIHBlZXIgZGVwZW5kZW5jaWVzLlxuICAgICAgICBucG1QYWNrYWdlSnNvbk1hcC5mb3JFYWNoKChucG1QYWNrYWdlSnNvbikgPT4ge1xuICAgICAgICAgIF9hZGRQYWNrYWdlR3JvdXAocGFja2FnZXMsIGFsbERlcGVuZGVuY2llcywgbnBtUGFja2FnZUpzb24sIGxvZ2dlcik7XG4gICAgICAgICAgX2FkZFBlZXJEZXBlbmRlbmNpZXMocGFja2FnZXMsIGFsbERlcGVuZGVuY2llcywgbnBtUGFja2FnZUpzb24sIGxvZ2dlcik7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEJ1aWxkIHRoZSBQYWNrYWdlSW5mbyBmb3IgZWFjaCBtb2R1bGUuXG4gICAgICAgIGNvbnN0IHBhY2thZ2VJbmZvTWFwID0gbmV3IE1hcDxzdHJpbmcsIFBhY2thZ2VJbmZvPigpO1xuICAgICAgICBucG1QYWNrYWdlSnNvbk1hcC5mb3JFYWNoKChucG1QYWNrYWdlSnNvbikgPT4ge1xuICAgICAgICAgIHBhY2thZ2VJbmZvTWFwLnNldChcbiAgICAgICAgICAgIG5wbVBhY2thZ2VKc29uLm5hbWUsXG4gICAgICAgICAgICBfYnVpbGRQYWNrYWdlSW5mbyh0cmVlLCBwYWNrYWdlcywgYWxsRGVwZW5kZW5jaWVzLCBucG1QYWNrYWdlSnNvbiwgbG9nZ2VyKSxcbiAgICAgICAgICApO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcGFja2FnZUluZm9NYXA7XG4gICAgICB9KSxcblxuICAgICAgc3dpdGNoTWFwKGluZm9NYXAgPT4ge1xuICAgICAgICAvLyBOb3cgdGhhdCB3ZSBoYXZlIGFsbCB0aGUgaW5mb3JtYXRpb24sIGNoZWNrIHRoZSBmbGFncy5cbiAgICAgICAgaWYgKHBhY2thZ2VzLnNpemUgPiAwKSB7XG4gICAgICAgICAgY29uc3Qgc3VibG9nID0gbmV3IGxvZ2dpbmcuTGV2ZWxDYXBMb2dnZXIoXG4gICAgICAgICAgICAndmFsaWRhdGlvbicsXG4gICAgICAgICAgICBsb2dnZXIuY3JlYXRlQ2hpbGQoJycpLFxuICAgICAgICAgICAgJ3dhcm4nLFxuICAgICAgICAgICk7XG4gICAgICAgICAgX3ZhbGlkYXRlVXBkYXRlUGFja2FnZXMoaW5mb01hcCwgb3B0aW9ucy5mb3JjZSwgc3VibG9nKTtcblxuICAgICAgICAgIHJldHVybiBfcGVyZm9ybVVwZGF0ZSh0cmVlLCBjb250ZXh0LCBpbmZvTWFwLCBsb2dnZXIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiBfdXNhZ2VNZXNzYWdlKG9wdGlvbnMsIGluZm9NYXAsIGxvZ2dlcik7XG4gICAgICAgIH1cbiAgICAgIH0pLFxuXG4gICAgICBzd2l0Y2hNYXAoKCkgPT4gb2YodHJlZSkpLFxuICAgICk7XG4gIH07XG59XG4iXX0=