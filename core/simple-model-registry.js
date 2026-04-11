function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

export class SimpleModelRegistry {
  constructor({ providerRegistry, modelCatalog, authStore }) {
    this._providerRegistry = providerRegistry;
    this._modelCatalog = modelCatalog;
    this._authStore = authStore;
  }

  _isProviderAvailable(providerId) {
    const providerEntry = this._providerRegistry?.get(providerId);
    if (!providerEntry) return false;
    if (providerEntry.authType === "none") return true;

    const creds = this._authStore?.get(providerId);
    if (!creds) {
      return isLocalBaseUrl(providerEntry.baseUrl);
    }
    return !!(creds.baseUrl && (creds.apiKey || isLocalBaseUrl(creds.baseUrl)));
  }

  _toRuntimeEntry(entry) {
    const creds = this._authStore?.get(entry.providerId) || null;
    return this._modelCatalog.toSdkEntry({
      ...entry,
      baseUrl: creds?.baseUrl || entry.baseUrl,
      api: creds?.api || entry.api,
    });
  }

  async getAvailable() {
    return this.getAll().filter((entry) => this._isProviderAvailable(entry.provider));
  }

  getAll() {
    return this._modelCatalog.list().map((entry) => this._toRuntimeEntry(entry));
  }

  refresh() {
    // no-op: callers rebuild ModelCatalog/AuthStore separately
  }
}
