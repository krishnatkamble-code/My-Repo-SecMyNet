(function() {
  if (typeof window === 'undefined') return;

  function sanitizeEntries(entries) {
    if (Array.isArray(entries)) {
      entries.forEach(function(entry) {
        if (entry && Array.isArray(entry.sources)) {
          entry.sources = entry.sources.filter(Boolean);
        }
      });
    }
    return entries;
  }

  // Patch PerformanceObserverEntryList methods
  if (window.PerformanceObserverEntryList) {
    try {
      ['getEntries', 'getEntriesByType', 'getEntriesByName'].forEach(function(method) {
        var orig = PerformanceObserverEntryList.prototype[method];
        if (orig) {
          PerformanceObserverEntryList.prototype[method] = function() {
            return sanitizeEntries(orig.apply(this, arguments));
          };
        }
      });
    } catch (e) {}
  }

  // Patch window.performance (Performance.prototype) methods
  if (window.Performance && Performance.prototype) {
    try {
      ['getEntries', 'getEntriesByType', 'getEntriesByName'].forEach(function(method) {
        var orig = Performance.prototype[method];
        if (orig) {
          Performance.prototype[method] = function() {
            return sanitizeEntries(orig.apply(this, arguments));
          };
        }
      });
    } catch (e) {}
  }
})();
