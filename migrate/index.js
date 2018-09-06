"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const schematics_1 = require("@angular-devkit/schematics");
const semver = require("semver");
/**
 * Cleans up "short" version numbers so they become valid semver. For example;
 *   1 => 1.0.0
 *   1.2 => 1.2.0
 *   1-beta => 1.0.0-beta
 *
 * Exported for testing only.
 */
function _coerceVersionNumber(version) {
    if (!version.match(/^\d{1,30}\.\d{1,30}\.\d{1,30}/)) {
        const match = version.match(/^\d{1,30}(\.\d{1,30})*/);
        if (!match) {
            return null;
        }
        if (!match[1]) {
            version = version.substr(0, match[0].length) + '.0.0' + version.substr(match[0].length);
        }
        else if (!match[2]) {
            version = version.substr(0, match[0].length) + '.0' + version.substr(match[0].length);
        }
        else {
            return null;
        }
    }
    return semver.valid(version);
}
exports._coerceVersionNumber = _coerceVersionNumber;
function default_1(options) {
    return (tree, context) => {
        const schematicsToRun = [];
        // Create the collection for the package.
        const collection = context.engine.createCollection(options.collection);
        for (const name of collection.listSchematicNames()) {
            const schematic = collection.createSchematic(name, true);
            const description = schematic.description;
            let version = description['version'];
            if (typeof version == 'string') {
                version = _coerceVersionNumber(version);
                if (!version) {
                    throw new schematics_1.SchematicsException(`Invalid migration version: ${JSON.stringify(description['version'])}`);
                }
                if (semver.gt(version, options.from) && semver.lte(version, options.to)) {
                    schematicsToRun.push({ name, version });
                }
            }
        }
        schematicsToRun.sort((a, b) => {
            const cmp = semver.compare(a.version, b.version);
            // Revert to comparing the names of the collection if the versions are equal.
            return cmp == 0 ? a.name.localeCompare(b.name) : cmp;
        });
        if (schematicsToRun.length > 0) {
            const rules = schematicsToRun.map(x => schematics_1.externalSchematic(options.collection, x.name, {}));
            return schematics_1.chain(rules);
        }
        return tree;
    };
}
exports.default = default_1;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiLi8iLCJzb3VyY2VzIjpbInBhY2thZ2VzL3NjaGVtYXRpY3MvdXBkYXRlL21pZ3JhdGUvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFRQSwyREFPb0M7QUFDcEMsaUNBQWlDO0FBSWpDOzs7Ozs7O0dBT0c7QUFDSCxTQUFnQixvQkFBb0IsQ0FBQyxPQUFlO0lBQ2xELElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLCtCQUErQixDQUFDLEVBQUU7UUFDbkQsTUFBTSxLQUFLLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO1FBRXRELElBQUksQ0FBQyxLQUFLLEVBQUU7WUFDVixPQUFPLElBQUksQ0FBQztTQUNiO1FBRUQsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRTtZQUNiLE9BQU8sR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsTUFBTSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1NBQ3pGO2FBQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRTtZQUNwQixPQUFPLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLElBQUksR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQztTQUN2RjthQUFNO1lBQ0wsT0FBTyxJQUFJLENBQUM7U0FDYjtLQUNGO0lBRUQsT0FBTyxNQUFNLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQy9CLENBQUM7QUFsQkQsb0RBa0JDO0FBR0QsbUJBQXdCLE9BQXlCO0lBQy9DLE9BQU8sQ0FBQyxJQUFVLEVBQUUsT0FBeUIsRUFBRSxFQUFFO1FBQy9DLE1BQU0sZUFBZSxHQUF5QyxFQUFFLENBQUM7UUFFakUseUNBQXlDO1FBQ3pDLE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ3ZFLEtBQUssTUFBTSxJQUFJLElBQUksVUFBVSxDQUFDLGtCQUFrQixFQUFFLEVBQUU7WUFDbEQsTUFBTSxTQUFTLEdBQUcsVUFBVSxDQUFDLGVBQWUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7WUFFekQsTUFBTSxXQUFXLEdBQWUsU0FBUyxDQUFDLFdBQXlCLENBQUM7WUFDcEUsSUFBSSxPQUFPLEdBQUcsV0FBVyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBRXJDLElBQUksT0FBTyxPQUFPLElBQUksUUFBUSxFQUFFO2dCQUM5QixPQUFPLEdBQUcsb0JBQW9CLENBQUMsT0FBTyxDQUFDLENBQUM7Z0JBRXhDLElBQUksQ0FBQyxPQUFPLEVBQUU7b0JBQ1osTUFBTSxJQUFJLGdDQUFtQixDQUMzQiw4QkFBOEIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxXQUFXLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUN2RSxDQUFDO2lCQUNIO2dCQUVELElBQUksTUFBTSxDQUFDLEVBQUUsQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUMsT0FBTyxFQUFFLE9BQU8sQ0FBQyxFQUFFLENBQUMsRUFBRTtvQkFDdkUsZUFBZSxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsQ0FBQyxDQUFDO2lCQUN6QzthQUNGO1NBQ0Y7UUFFRCxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFO1lBQzVCLE1BQU0sR0FBRyxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUM7WUFFakQsNkVBQTZFO1lBQzdFLE9BQU8sR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7UUFDdkQsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLGVBQWUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO1lBQzlCLE1BQU0sS0FBSyxHQUFHLGVBQWUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyw4QkFBaUIsQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQztZQUUxRixPQUFPLGtCQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7U0FDckI7UUFFRCxPQUFPLElBQUksQ0FBQztJQUNkLENBQUMsQ0FBQztBQUNKLENBQUM7QUExQ0QsNEJBMENDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBAbGljZW5zZVxuICogQ29weXJpZ2h0IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG4gKlxuICogVXNlIG9mIHRoaXMgc291cmNlIGNvZGUgaXMgZ292ZXJuZWQgYnkgYW4gTUlULXN0eWxlIGxpY2Vuc2UgdGhhdCBjYW4gYmVcbiAqIGZvdW5kIGluIHRoZSBMSUNFTlNFIGZpbGUgYXQgaHR0cHM6Ly9hbmd1bGFyLmlvL2xpY2Vuc2VcbiAqL1xuaW1wb3J0IHsgSnNvbk9iamVjdCB9IGZyb20gJ0Bhbmd1bGFyLWRldmtpdC9jb3JlJztcbmltcG9ydCB7XG4gIFJ1bGUsXG4gIFNjaGVtYXRpY0NvbnRleHQsXG4gIFNjaGVtYXRpY3NFeGNlcHRpb24sXG4gIFRyZWUsXG4gIGNoYWluLFxuICBleHRlcm5hbFNjaGVtYXRpYyxcbn0gZnJvbSAnQGFuZ3VsYXItZGV2a2l0L3NjaGVtYXRpY3MnO1xuaW1wb3J0ICogYXMgc2VtdmVyIGZyb20gJ3NlbXZlcic7XG5pbXBvcnQgeyBQb3N0VXBkYXRlU2NoZW1hIH0gZnJvbSAnLi9zY2hlbWEnO1xuXG5cbi8qKlxuICogQ2xlYW5zIHVwIFwic2hvcnRcIiB2ZXJzaW9uIG51bWJlcnMgc28gdGhleSBiZWNvbWUgdmFsaWQgc2VtdmVyLiBGb3IgZXhhbXBsZTtcbiAqICAgMSA9PiAxLjAuMFxuICogICAxLjIgPT4gMS4yLjBcbiAqICAgMS1iZXRhID0+IDEuMC4wLWJldGFcbiAqXG4gKiBFeHBvcnRlZCBmb3IgdGVzdGluZyBvbmx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gX2NvZXJjZVZlcnNpb25OdW1iZXIodmVyc2lvbjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghdmVyc2lvbi5tYXRjaCgvXlxcZHsxLDMwfVxcLlxcZHsxLDMwfVxcLlxcZHsxLDMwfS8pKSB7XG4gICAgY29uc3QgbWF0Y2ggPSB2ZXJzaW9uLm1hdGNoKC9eXFxkezEsMzB9KFxcLlxcZHsxLDMwfSkqLyk7XG5cbiAgICBpZiAoIW1hdGNoKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAoIW1hdGNoWzFdKSB7XG4gICAgICB2ZXJzaW9uID0gdmVyc2lvbi5zdWJzdHIoMCwgbWF0Y2hbMF0ubGVuZ3RoKSArICcuMC4wJyArIHZlcnNpb24uc3Vic3RyKG1hdGNoWzBdLmxlbmd0aCk7XG4gICAgfSBlbHNlIGlmICghbWF0Y2hbMl0pIHtcbiAgICAgIHZlcnNpb24gPSB2ZXJzaW9uLnN1YnN0cigwLCBtYXRjaFswXS5sZW5ndGgpICsgJy4wJyArIHZlcnNpb24uc3Vic3RyKG1hdGNoWzBdLmxlbmd0aCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBzZW12ZXIudmFsaWQodmVyc2lvbik7XG59XG5cblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24ob3B0aW9uczogUG9zdFVwZGF0ZVNjaGVtYSk6IFJ1bGUge1xuICByZXR1cm4gKHRyZWU6IFRyZWUsIGNvbnRleHQ6IFNjaGVtYXRpY0NvbnRleHQpID0+IHtcbiAgICBjb25zdCBzY2hlbWF0aWNzVG9SdW46IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IH1bXSA9IFtdO1xuXG4gICAgLy8gQ3JlYXRlIHRoZSBjb2xsZWN0aW9uIGZvciB0aGUgcGFja2FnZS5cbiAgICBjb25zdCBjb2xsZWN0aW9uID0gY29udGV4dC5lbmdpbmUuY3JlYXRlQ29sbGVjdGlvbihvcHRpb25zLmNvbGxlY3Rpb24pO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBjb2xsZWN0aW9uLmxpc3RTY2hlbWF0aWNOYW1lcygpKSB7XG4gICAgICBjb25zdCBzY2hlbWF0aWMgPSBjb2xsZWN0aW9uLmNyZWF0ZVNjaGVtYXRpYyhuYW1lLCB0cnVlKTtcblxuICAgICAgY29uc3QgZGVzY3JpcHRpb246IEpzb25PYmplY3QgPSBzY2hlbWF0aWMuZGVzY3JpcHRpb24gYXMgSnNvbk9iamVjdDtcbiAgICAgIGxldCB2ZXJzaW9uID0gZGVzY3JpcHRpb25bJ3ZlcnNpb24nXTtcblxuICAgICAgaWYgKHR5cGVvZiB2ZXJzaW9uID09ICdzdHJpbmcnKSB7XG4gICAgICAgIHZlcnNpb24gPSBfY29lcmNlVmVyc2lvbk51bWJlcih2ZXJzaW9uKTtcblxuICAgICAgICBpZiAoIXZlcnNpb24pIHtcbiAgICAgICAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbihcbiAgICAgICAgICAgIGBJbnZhbGlkIG1pZ3JhdGlvbiB2ZXJzaW9uOiAke0pTT04uc3RyaW5naWZ5KGRlc2NyaXB0aW9uWyd2ZXJzaW9uJ10pfWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzZW12ZXIuZ3QodmVyc2lvbiwgb3B0aW9ucy5mcm9tKSAmJiBzZW12ZXIubHRlKHZlcnNpb24sIG9wdGlvbnMudG8pKSB7XG4gICAgICAgICAgc2NoZW1hdGljc1RvUnVuLnB1c2goeyBuYW1lLCB2ZXJzaW9uIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgc2NoZW1hdGljc1RvUnVuLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgIGNvbnN0IGNtcCA9IHNlbXZlci5jb21wYXJlKGEudmVyc2lvbiwgYi52ZXJzaW9uKTtcblxuICAgICAgLy8gUmV2ZXJ0IHRvIGNvbXBhcmluZyB0aGUgbmFtZXMgb2YgdGhlIGNvbGxlY3Rpb24gaWYgdGhlIHZlcnNpb25zIGFyZSBlcXVhbC5cbiAgICAgIHJldHVybiBjbXAgPT0gMCA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBjbXA7XG4gICAgfSk7XG5cbiAgICBpZiAoc2NoZW1hdGljc1RvUnVuLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHJ1bGVzID0gc2NoZW1hdGljc1RvUnVuLm1hcCh4ID0+IGV4dGVybmFsU2NoZW1hdGljKG9wdGlvbnMuY29sbGVjdGlvbiwgeC5uYW1lLCB7fSkpO1xuXG4gICAgICByZXR1cm4gY2hhaW4ocnVsZXMpO1xuICAgIH1cblxuICAgIHJldHVybiB0cmVlO1xuICB9O1xufVxuIl19