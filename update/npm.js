"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http = require("http");
const rxjs_1 = require("rxjs");
const npmPackageJsonCache = new Map();
/**
 * Get the NPM repository's package.json for a package. This is p
 * @param {string} packageName The package name to fetch.
 * @param {LoggerApi} logger A logger instance to log debug information.
 * @returns An observable that will put the pacakge.json content.
 * @private
 */
function getNpmPackageJson(packageName, logger) {
    const url = `http://registry.npmjs.org/${packageName.replace(/\//g, '%2F')}`;
    logger.debug(`Getting package.json from ${JSON.stringify(packageName)} (url: ${JSON.stringify(url)})...`);
    let maybeRequest = npmPackageJsonCache.get(url);
    if (!maybeRequest) {
        const subject = new rxjs_1.ReplaySubject(1);
        const request = http.request(url, response => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    subject.next(json);
                    subject.complete();
                }
                catch (err) {
                    subject.error(err);
                }
            });
            response.on('error', err => subject.error(err));
        });
        request.end();
        maybeRequest = subject.asObservable();
        npmPackageJsonCache.set(url, maybeRequest);
    }
    return maybeRequest;
}
exports.getNpmPackageJson = getNpmPackageJson;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibnBtLmpzIiwic291cmNlUm9vdCI6Ii4vIiwic291cmNlcyI6WyJwYWNrYWdlcy9zY2hlbWF0aWNzL3VwZGF0ZS91cGRhdGUvbnBtLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBUUEsNkJBQTZCO0FBQzdCLCtCQUFpRDtBQUlqRCxNQUFNLG1CQUFtQixHQUFHLElBQUksR0FBRyxFQUFnRCxDQUFDO0FBR3BGOzs7Ozs7R0FNRztBQUNILDJCQUNFLFdBQW1CLEVBQ25CLE1BQXlCO0lBRXpCLE1BQU0sR0FBRyxHQUFHLDZCQUE2QixXQUFXLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDO0lBQzdFLE1BQU0sQ0FBQyxLQUFLLENBQ1YsNkJBQTZCLElBQUksQ0FBQyxTQUFTLENBQUMsV0FBVyxDQUFDLFVBQVUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUM1RixDQUFDO0lBRUYsSUFBSSxZQUFZLEdBQUcsbUJBQW1CLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ2hELEVBQUUsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQztRQUNsQixNQUFNLE9BQU8sR0FBRyxJQUFJLG9CQUFhLENBQTJCLENBQUMsQ0FBQyxDQUFDO1FBRS9ELE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLFFBQVEsQ0FBQyxFQUFFO1lBQzNDLElBQUksSUFBSSxHQUFHLEVBQUUsQ0FBQztZQUNkLFFBQVEsQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxJQUFJLEtBQUssQ0FBQyxDQUFDO1lBQzVDLFFBQVEsQ0FBQyxFQUFFLENBQUMsS0FBSyxFQUFFLEdBQUcsRUFBRTtnQkFDdEIsSUFBSSxDQUFDO29CQUNILE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQzlCLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBZ0MsQ0FBQyxDQUFDO29CQUMvQyxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQ3JCLENBQUM7Z0JBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztvQkFDYixPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixDQUFDO1lBQ0gsQ0FBQyxDQUFDLENBQUM7WUFDSCxRQUFRLENBQUMsRUFBRSxDQUFDLE9BQU8sRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztRQUNsRCxDQUFDLENBQUMsQ0FBQztRQUNILE9BQU8sQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUVkLFlBQVksR0FBRyxPQUFPLENBQUMsWUFBWSxFQUFFLENBQUM7UUFDdEMsbUJBQW1CLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxZQUFZLENBQUMsQ0FBQztJQUM3QyxDQUFDO0lBRUQsTUFBTSxDQUFDLFlBQVksQ0FBQztBQUN0QixDQUFDO0FBbENELDhDQWtDQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQGxpY2Vuc2VcbiAqIENvcHlyaWdodCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuICpcbiAqIFVzZSBvZiB0aGlzIHNvdXJjZSBjb2RlIGlzIGdvdmVybmVkIGJ5IGFuIE1JVC1zdHlsZSBsaWNlbnNlIHRoYXQgY2FuIGJlXG4gKiBmb3VuZCBpbiB0aGUgTElDRU5TRSBmaWxlIGF0IGh0dHBzOi8vYW5ndWxhci5pby9saWNlbnNlXG4gKi9cbmltcG9ydCB7IGxvZ2dpbmcgfSBmcm9tICdAYW5ndWxhci1kZXZraXQvY29yZSc7XG5pbXBvcnQgKiBhcyBodHRwIGZyb20gJ2h0dHAnO1xuaW1wb3J0IHsgT2JzZXJ2YWJsZSwgUmVwbGF5U3ViamVjdCB9IGZyb20gJ3J4anMnO1xuaW1wb3J0IHsgTnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uIH0gZnJvbSAnLi9ucG0tcGFja2FnZS1qc29uJztcblxuXG5jb25zdCBucG1QYWNrYWdlSnNvbkNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIE9ic2VydmFibGU8TnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uPj4oKTtcblxuXG4vKipcbiAqIEdldCB0aGUgTlBNIHJlcG9zaXRvcnkncyBwYWNrYWdlLmpzb24gZm9yIGEgcGFja2FnZS4gVGhpcyBpcyBwXG4gKiBAcGFyYW0ge3N0cmluZ30gcGFja2FnZU5hbWUgVGhlIHBhY2thZ2UgbmFtZSB0byBmZXRjaC5cbiAqIEBwYXJhbSB7TG9nZ2VyQXBpfSBsb2dnZXIgQSBsb2dnZXIgaW5zdGFuY2UgdG8gbG9nIGRlYnVnIGluZm9ybWF0aW9uLlxuICogQHJldHVybnMgQW4gb2JzZXJ2YWJsZSB0aGF0IHdpbGwgcHV0IHRoZSBwYWNha2dlLmpzb24gY29udGVudC5cbiAqIEBwcml2YXRlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXROcG1QYWNrYWdlSnNvbihcbiAgcGFja2FnZU5hbWU6IHN0cmluZyxcbiAgbG9nZ2VyOiBsb2dnaW5nLkxvZ2dlckFwaSxcbik6IE9ic2VydmFibGU8TnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uPiB7XG4gIGNvbnN0IHVybCA9IGBodHRwOi8vcmVnaXN0cnkubnBtanMub3JnLyR7cGFja2FnZU5hbWUucmVwbGFjZSgvXFwvL2csICclMkYnKX1gO1xuICBsb2dnZXIuZGVidWcoXG4gICAgYEdldHRpbmcgcGFja2FnZS5qc29uIGZyb20gJHtKU09OLnN0cmluZ2lmeShwYWNrYWdlTmFtZSl9ICh1cmw6ICR7SlNPTi5zdHJpbmdpZnkodXJsKX0pLi4uYCxcbiAgKTtcblxuICBsZXQgbWF5YmVSZXF1ZXN0ID0gbnBtUGFja2FnZUpzb25DYWNoZS5nZXQodXJsKTtcbiAgaWYgKCFtYXliZVJlcXVlc3QpIHtcbiAgICBjb25zdCBzdWJqZWN0ID0gbmV3IFJlcGxheVN1YmplY3Q8TnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uPigxKTtcblxuICAgIGNvbnN0IHJlcXVlc3QgPSBodHRwLnJlcXVlc3QodXJsLCByZXNwb25zZSA9PiB7XG4gICAgICBsZXQgZGF0YSA9ICcnO1xuICAgICAgcmVzcG9uc2Uub24oJ2RhdGEnLCBjaHVuayA9PiBkYXRhICs9IGNodW5rKTtcbiAgICAgIHJlc3BvbnNlLm9uKCdlbmQnLCAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QganNvbiA9IEpTT04ucGFyc2UoZGF0YSk7XG4gICAgICAgICAgc3ViamVjdC5uZXh0KGpzb24gYXMgTnBtUmVwb3NpdG9yeVBhY2thZ2VKc29uKTtcbiAgICAgICAgICBzdWJqZWN0LmNvbXBsZXRlKCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHN1YmplY3QuZXJyb3IoZXJyKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICByZXNwb25zZS5vbignZXJyb3InLCBlcnIgPT4gc3ViamVjdC5lcnJvcihlcnIpKTtcbiAgICB9KTtcbiAgICByZXF1ZXN0LmVuZCgpO1xuXG4gICAgbWF5YmVSZXF1ZXN0ID0gc3ViamVjdC5hc09ic2VydmFibGUoKTtcbiAgICBucG1QYWNrYWdlSnNvbkNhY2hlLnNldCh1cmwsIG1heWJlUmVxdWVzdCk7XG4gIH1cblxuICByZXR1cm4gbWF5YmVSZXF1ZXN0O1xufVxuIl19