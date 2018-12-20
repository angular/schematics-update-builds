"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const os_1 = require("os");
const path = require("path");
const rxjs_1 = require("rxjs");
const operators_1 = require("rxjs/operators");
const ini = require('ini');
const lockfile = require('@yarnpkg/lockfile');
const pacote = require('pacote');
const npmPackageJsonCache = new Map();
let npmrc;
function readOptions(logger, yarn = false, showPotentials = false) {
    const cwd = process.cwd();
    const baseFilename = yarn ? 'yarnrc' : 'npmrc';
    const dotFilename = '.' + baseFilename;
    let globalPrefix;
    if (process.env.PREFIX) {
        globalPrefix = process.env.PREFIX;
    }
    else {
        globalPrefix = path.dirname(process.execPath);
        if (process.platform !== 'win32') {
            globalPrefix = path.dirname(globalPrefix);
        }
    }
    const defaultConfigLocations = [
        path.join(globalPrefix, 'etc', baseFilename),
        path.join(os_1.homedir(), dotFilename),
    ];
    const projectConfigLocations = [
        path.join(cwd, dotFilename),
    ];
    const root = path.parse(cwd).root;
    for (let curDir = path.dirname(cwd); curDir && curDir !== root; curDir = path.dirname(curDir)) {
        projectConfigLocations.unshift(path.join(curDir, dotFilename));
    }
    if (showPotentials) {
        logger.info(`Locating potential ${baseFilename} files:`);
    }
    let options = {};
    for (const location of [...defaultConfigLocations, ...projectConfigLocations]) {
        if (fs_1.existsSync(location)) {
            if (showPotentials) {
                logger.info(`Trying '${location}'...found.`);
            }
            const data = fs_1.readFileSync(location, 'utf8');
            options = Object.assign({}, options, (yarn ? lockfile.parse(data) : ini.parse(data)));
            if (options.cafile) {
                const cafile = path.resolve(path.dirname(location), options.cafile);
                delete options.cafile;
                try {
                    options.ca = fs_1.readFileSync(cafile, 'utf8').replace(/\r?\n/, '\\n');
                }
                catch (_a) { }
            }
        }
        else if (showPotentials) {
            logger.info(`Trying '${location}'...not found.`);
        }
    }
    // Substitute any environment variable references
    for (const key in options) {
        options[key] = options[key].replace(/\$\{([^\}]+)\}/, (_, name) => process.env[name] || '');
    }
    return options;
}
/**
 * Get the NPM repository's package.json for a package. This is p
 * @param {string} packageName The package name to fetch.
 * @param {string} registryUrl The NPM Registry URL to use.
 * @param {LoggerApi} logger A logger instance to log debug information.
 * @returns An observable that will put the pacakge.json content.
 * @private
 */
function getNpmPackageJson(packageName, logger, options) {
    const cachedResponse = npmPackageJsonCache.get(packageName);
    if (cachedResponse) {
        return cachedResponse;
    }
    if (!npmrc) {
        try {
            npmrc = readOptions(logger, false, options && options.verbose);
        }
        catch (_a) { }
        if (options && options.usingYarn) {
            try {
                npmrc = Object.assign({}, npmrc, readOptions(logger, true, options && options.verbose));
            }
            catch (_b) { }
        }
    }
    const resultPromise = pacote.packument(packageName, Object.assign({ 'full-metadata': true }, npmrc, (options && options.registryUrl ? { registry: options.registryUrl } : {})));
    // TODO: find some way to test this
    const response = rxjs_1.from(resultPromise).pipe(operators_1.shareReplay(), operators_1.catchError(err => {
        logger.warn(err.message || err);
        return rxjs_1.EMPTY;
    }));
    npmPackageJsonCache.set(packageName, response);
    return response;
}
exports.getNpmPackageJson = getNpmPackageJson;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibnBtLmpzIiwic291cmNlUm9vdCI6Ii4vIiwic291cmNlcyI6WyJwYWNrYWdlcy9zY2hlbWF0aWNzL3VwZGF0ZS91cGRhdGUvbnBtLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBUUEsMkJBQThDO0FBQzlDLDJCQUE2QjtBQUM3Qiw2QkFBNkI7QUFDN0IsK0JBQStDO0FBQy9DLDhDQUF5RDtBQUd6RCxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDM0IsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLG1CQUFtQixDQUFDLENBQUM7QUFDOUMsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBRWpDLE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxHQUFHLEVBQWdELENBQUM7QUFDcEYsSUFBSSxLQUFnQyxDQUFDO0FBR3JDLFNBQVMsV0FBVyxDQUNsQixNQUF5QixFQUN6QixJQUFJLEdBQUcsS0FBSyxFQUNaLGNBQWMsR0FBRyxLQUFLO0lBRXRCLE1BQU0sR0FBRyxHQUFHLE9BQU8sQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUMxQixNQUFNLFlBQVksR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDO0lBQy9DLE1BQU0sV0FBVyxHQUFHLEdBQUcsR0FBRyxZQUFZLENBQUM7SUFFdkMsSUFBSSxZQUFvQixDQUFDO0lBQ3pCLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUU7UUFDdEIsWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDO0tBQ25DO1NBQU07UUFDTCxZQUFZLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDOUMsSUFBSSxPQUFPLENBQUMsUUFBUSxLQUFLLE9BQU8sRUFBRTtZQUNoQyxZQUFZLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsQ0FBQztTQUMz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Z2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cbiAqXG4gKiBVc2Ugb2YgdGhpcyBzb3VyY2UgY29kZSBpcyBnb3Zlcm5lZCBieSBhbiBNSVQtc3R5bGUgbGljZW5zZSB0aGF0IGNhbiBiZVxuICogZm91bmQgaW4gdGhlIExJQ0VOU0UgZmlsZSBhdCBodHRwczovL2FuZ3VsYXIuaW8vbGljZW5zZVxuICovXG5pbXBvcnQgeyBsb2dnaW5nIH0gZnJvbSAnQGFuZ3VsYXItZGV2a2l0L2NvcmUnO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSAnZnMnO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gJ29zJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBFTVBUWSwgT2JzZXJ2YWJsZSwgZnJvbSB9IGZyb20gJ3J4anMnO1xuaW1wb3J0IHsgY2F0Y2hFcnJvciwgc2hhcmVSZXBsYXkgfSBmcm9tICdyeGpzL29wZXJhdG9ycyc7XG5pbXBvcnQgeyBOcG1SZXBvc2l0b3J5UGFja2FnZUpzb24gfSBmcm9tICcuL25wbS1wYWNrYWdlLWpzb24nO1xuXG5jb25zdCBpbmkgPSByZXF1aXJlKCdpbmknKTtcbmNvbnN0IGxvY2tmaWxlID0gcmVxdWlyZSgnQHlhcm5wa2cvbG9ja2ZpbGUnKTtcbmNvbnN0IHBhY290ZSA9IHJlcXVpcmUoJ3BhY290ZScpO1xuXG5jb25zdCBucG1QYWNrYWdlSnNvbkNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIE9ic2VydmFibGU8TnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uPj4oKTtcbmxldCBucG1yYzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuXG5mdW5jdGlvbiByZWFkT3B0aW9ucyhcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbiAgeWFybiA9IGZhbHNlLFxuICBzaG93UG90ZW50aWFscyA9IGZhbHNlLFxuKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IGN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IGJhc2VGaWxlbmFtZSA9IHlhcm4gPyAneWFybnJjJyA6ICducG1yYyc7XG4gIGNvbnN0IGRvdEZpbGVuYW1lID0gJy4nICsgYmFzZUZpbGVuYW1lO1xuXG4gIGxldCBnbG9iYWxQcmVmaXg6IHN0cmluZztcbiAgaWYgKHByb2Nlc3MuZW52LlBSRUZJWCkge1xuICAgIGdsb2JhbFByZWZpeCA9IHByb2Nlc3MuZW52LlBSRUZJWDtcbiAgfSBlbHNlIHtcbiAgICBnbG9iYWxQcmVmaXggPSBwYXRoLmRpcm5hbWUocHJvY2Vzcy5leGVjUGF0aCk7XG4gICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICd3aW4zMicpIHtcbiAgICAgIGdsb2JhbFByZWZpeCA9IHBhdGguZGlybmFtZShnbG9iYWxQcmVmaXgpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRDb25maWdMb2NhdGlvbnMgPSBbXG4gICAgcGF0aC5qb2luKGdsb2JhbFByZWZpeCwgJ2V0YycsIGJhc2VGaWxlbmFtZSksXG4gICAgcGF0aC5qb2luKGhvbWVkaXIoKSwgZG90RmlsZW5hbWUpLFxuICBdO1xuXG4gIGNvbnN0IHByb2plY3RDb25maWdMb2NhdGlvbnM6IHN0cmluZ1tdID0gW1xuICAgIHBhdGguam9pbihjd2QsIGRvdEZpbGVuYW1lKSxcbiAgXTtcbiAgY29uc3Qgcm9vdCA9IHBhdGgucGFyc2UoY3dkKS5yb290O1xuICBmb3IgKGxldCBjdXJEaXIgPSBwYXRoLmRpcm5hbWUoY3dkKTsgY3VyRGlyICYmIGN1ckRpciAhPT0gcm9vdDsgY3VyRGlyID0gcGF0aC5kaXJuYW1lKGN1ckRpcikpIHtcbiAgICBwcm9qZWN0Q29uZmlnTG9jYXRpb25zLnVuc2hpZnQocGF0aC5qb2luKGN1ckRpciwgZG90RmlsZW5hbWUpKTtcbiAgfVxuXG4gIGlmIChzaG93UG90ZW50aWFscykge1xuICAgIGxvZ2dlci5pbmZvKGBMb2NhdGluZyBwb3RlbnRpYWwgJHtiYXNlRmlsZW5hbWV9IGZpbGVzOmApO1xuICB9XG5cbiAgbGV0IG9wdGlvbnM6IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH0gPSB7fTtcbiAgZm9yIChjb25zdCBsb2NhdGlvbiBvZiBbLi4uZGVmYXVsdENvbmZpZ0xvY2F0aW9ucywgLi4ucHJvamVjdENvbmZpZ0xvY2F0aW9uc10pIHtcbiAgICBpZiAoZXhpc3RzU3luYyhsb2NhdGlvbikpIHtcbiAgICAgIGlmIChzaG93UG90ZW50aWFscykge1xuICAgICAgICBsb2dnZXIuaW5mbyhgVHJ5aW5nICcke2xvY2F0aW9ufScuLi5mb3VuZC5gKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZGF0YSA9IHJlYWRGaWxlU3luYyhsb2NhdGlvbiwgJ3V0ZjgnKTtcbiAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgIC4uLm9wdGlvbnMsXG4gICAgICAgIC4uLih5YXJuID8gbG9ja2ZpbGUucGFyc2UoZGF0YSkgOiBpbmkucGFyc2UoZGF0YSkpLFxuICAgICAgfTtcblxuICAgICAgaWYgKG9wdGlvbnMuY2FmaWxlKSB7XG4gICAgICAgIGNvbnN0IGNhZmlsZSA9IHBhdGgucmVzb2x2ZShwYXRoLmRpcm5hbWUobG9jYXRpb24pLCBvcHRpb25zLmNhZmlsZSk7XG4gICAgICAgIGRlbGV0ZSBvcHRpb25zLmNhZmlsZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBvcHRpb25zLmNhID0gcmVhZEZpbGVTeW5jKGNhZmlsZSwgJ3V0ZjgnKS5yZXBsYWNlKC9cXHI/XFxuLywgJ1xcXFxuJyk7XG4gICAgICAgIH0gY2F0Y2ggeyB9XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChzaG93UG90ZW50aWFscykge1xuICAgICAgbG9nZ2VyLmluZm8oYFRyeWluZyAnJHtsb2NhdGlvbn0nLi4ubm90IGZvdW5kLmApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFN1YnN0aXR1dGUgYW55IGVudmlyb25tZW50IHZhcmlhYmxlIHJlZmVyZW5jZXNcbiAgZm9yIChjb25zdCBrZXkgaW4gb3B0aW9ucykge1xuICAgIG9wdGlvbnNba2V5XSA9IG9wdGlvbnNba2V5XS5yZXBsYWNlKC9cXCRcXHsoW15cXH1dKylcXH0vLCAoXywgbmFtZSkgPT4gcHJvY2Vzcy5lbnZbbmFtZV0gfHwgJycpO1xuICB9XG5cbiAgcmV0dXJuIG9wdGlvbnM7XG59XG5cbi8qKlxuICogR2V0IHRoZSBOUE0gcmVwb3NpdG9yeSdzIHBhY2thZ2UuanNvbiBmb3IgYSBwYWNrYWdlLiBUaGlzIGlzIHBcbiAqIEBwYXJhbSB7c3RyaW5nfSBwYWNrYWdlTmFtZSBUaGUgcGFja2FnZSBuYW1lIHRvIGZldGNoLlxuICogQHBhcmFtIHtzdHJpbmd9IHJlZ2lzdHJ5VXJsIFRoZSBOUE0gUmVnaXN0cnkgVVJMIHRvIHVzZS5cbiAqIEBwYXJhbSB7TG9nZ2VyQXBpfSBsb2dnZXIgQSBsb2dnZXIgaW5zdGFuY2UgdG8gbG9nIGRlYnVnIGluZm9ybWF0aW9uLlxuICogQHJldHVybnMgQW4gb2JzZXJ2YWJsZSB0aGF0IHdpbGwgcHV0IHRoZSBwYWNha2dlLmpzb24gY29udGVudC5cbiAqIEBwcml2YXRlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXROcG1QYWNrYWdlSnNvbihcbiAgcGFja2FnZU5hbWU6IHN0cmluZyxcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbiAgb3B0aW9ucz86IHtcbiAgICByZWdpc3RyeVVybD86IHN0cmluZztcbiAgICB1c2luZ1lhcm4/OiBib29sZWFuO1xuICAgIHZlcmJvc2U/OiBib29sZWFuO1xuICB9LFxuKTogT2JzZXJ2YWJsZTxQYXJ0aWFsPE5wbVJlcG9zaXRvcnlQYWNrYWdlSnNvbj4+IHtcbiAgY29uc3QgY2FjaGVkUmVzcG9uc2UgPSBucG1QYWNrYWdlSnNvbkNhY2hlLmdldChwYWNrYWdlTmFtZSk7XG4gIGlmIChjYWNoZWRSZXNwb25zZSkge1xuICAgIHJldHVybiBjYWNoZWRSZXNwb25zZTtcbiAgfVxuXG4gIGlmICghbnBtcmMpIHtcbiAgICB0cnkge1xuICAgICAgbnBtcmMgPSByZWFkT3B0aW9ucyhsb2dnZXIsIGZhbHNlLCBvcHRpb25zICYmIG9wdGlvbnMudmVyYm9zZSk7XG4gICAgfSBjYXRjaCB7IH1cblxuICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMudXNpbmdZYXJuKSB7XG4gICAgICB0cnkge1xuICAgICAgICBucG1yYyA9IHsgLi4ubnBtcmMsIC4uLnJlYWRPcHRpb25zKGxvZ2dlciwgdHJ1ZSwgb3B0aW9ucyAmJiBvcHRpb25zLnZlcmJvc2UpIH07XG4gICAgICB9IGNhdGNoIHsgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHJlc3VsdFByb21pc2UgPSBwYWNvdGUucGFja3VtZW50KFxuICAgIHBhY2thZ2VOYW1lLFxuICAgIHtcbiAgICAgICdmdWxsLW1ldGFkYXRhJzogdHJ1ZSxcbiAgICAgIC4uLm5wbXJjLFxuICAgICAgLi4uKG9wdGlvbnMgJiYgb3B0aW9ucy5yZWdpc3RyeVVybCA/IHsgcmVnaXN0cnk6IG9wdGlvbnMucmVnaXN0cnlVcmwgfSA6IHt9KSxcbiAgICB9LFxuICApO1xuXG4gIC8vIFRPRE86IGZpbmQgc29tZSB3YXkgdG8gdGVzdCB0aGlzXG4gIGNvbnN0IHJlc3BvbnNlID0gZnJvbTxOcG1SZXBvc2l0b3J5UGFja2FnZUpzb24+KHJlc3VsdFByb21pc2UpLnBpcGUoXG4gICAgc2hhcmVSZXBsYXkoKSxcbiAgICBjYXRjaEVycm9yKGVyciA9PiB7XG4gICAgICBsb2dnZXIud2FybihlcnIubWVzc2FnZSB8fCBlcnIpO1xuXG4gICAgICByZXR1cm4gRU1QVFk7XG4gICAgfSksXG4gICk7XG4gIG5wbVBhY2thZ2VKc29uQ2FjaGUuc2V0KHBhY2thZ2VOYW1lLCByZXNwb25zZSk7XG5cbiAgcmV0dXJuIHJlc3BvbnNlO1xufVxuIl19