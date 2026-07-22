angular.module("financier").factory("plaidLink", ($q, $http) => {
  let scriptLoadedPromise = null;

  /**
   * Lazy load the Plaid Link JS SDK (https://cdn.plaid.com/link/v2/stable/link-initialize.js)
   */
  function loadScript() {
    if (scriptLoadedPromise) {
      return scriptLoadedPromise;
    }

    const deferred = $q.defer();

    if (window.Plaid) {
      deferred.resolve(window.Plaid);
      return deferred.promise;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.onload = () => {
      deferred.resolve(window.Plaid);
    };
    script.onerror = () => {
      deferred.reject(new Error("Failed to load Plaid Link SDK"));
    };

    document.body.appendChild(script);
    scriptLoadedPromise = deferred.promise;
    return scriptLoadedPromise;
  }

  return {
    /**
     * Ensure the Plaid SDK script is loaded
     */
    loadScript,

    /**
     * Create a link token for Plaid Link
     */
    createLinkToken(budgetId) {
      return $http.post("/plaid/create_link_token", { budgetId }).then((res) => res.data);
    },

    /**
     * Open Plaid Link widget
     * Returns a promise resolving to { public_token, metadata } on success
     */
    openLink(linkToken) {
      const deferred = $q.defer();

      loadScript().then((Plaid) => {
        const handler = Plaid.create({
          token: linkToken,
          onSuccess: (public_token, metadata) => {
            deferred.resolve({ public_token, metadata });
          },
          onExit: (err, metadata) => {
            if (err) {
              deferred.reject(err);
            } else {
              deferred.reject({ cancelled: true, metadata });
            }
          },
          onEvent: (eventName, metadata) => {
            // Optional event logging
          },
        });

        handler.open();
      }).catch(deferred.reject);

      return deferred.promise;
    },

    /**
     * Exchange public_token for access_token and store initial account mappings
     */
    exchangeToken(publicToken, budgetId, accountMappings) {
      return $http
        .post("/plaid/exchange_token", {
          public_token: publicToken,
          budgetId,
          accountMappings,
        })
        .then((res) => res.data);
    },

    /**
     * Trigger a transaction sync for a budget or specific item
     */
    sync(budgetId, itemId) {
      return $http
        .post("/plaid/sync", { budgetId, itemId })
        .then((res) => res.data);
    },

    /**
     * List linked accounts for a budget
     */
    getAccounts(budgetId) {
      return $http
        .get(`/plaid/accounts?budgetId=${encodeURIComponent(budgetId)}`)
        .then((res) => res.data);
    },

    /**
     * Remove a linked Plaid item
     */
    unlink(itemId, budgetId) {
      return $http
        .post("/plaid/unlink", { itemId, budgetId })
        .then((res) => res.data);
    },

    /**
     * Update account mappings for an existing linked item
     */
    updateMappings(itemId, accountMappings) {
      return $http
        .post("/plaid/update_mappings", { itemId, accountMappings })
        .then((res) => res.data);
    },
  };
});
