(function() {
  if (typeof window !== 'undefined' && window.PerformanceObserverEntryList) {
    try {
      ['getEntries', 'getEntriesByType', 'getEntriesByName'].forEach(function(method) {
        var orig = PerformanceObserverEntryList.prototype[method];
        if (orig) {
          PerformanceObserverEntryList.prototype[method] = function() {
            var entries = orig.apply(this, arguments);
            if (Array.isArray(entries)) {
              entries.forEach(function(entry) {
                if (entry && Array.isArray(entry.sources)) {
                  entry.sources = entry.sources.filter(Boolean);
                }
              });
            }
            return entries;
          };
        }
      });
    } catch (e) {}
  }
})();
