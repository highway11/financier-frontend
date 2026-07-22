angular
  .module("financier")
  .controller(
    "plaidLinkCtrl",
    function (
      $scope,
      $stateParams,
      $translate,
      $q,
      plaidLink,
      account,
      ngDialog
    ) {
      const that = this;
      const budgetId = $stateParams.budgetId;
      const Account = account(budgetId);

      this.budgetId = budgetId;
      this.step = "MANAGE"; // 'MANAGE' or 'MAP_ACCOUNTS'
      this.loading = true;
      this.syncing = false;
      this.error = null;
      this.successMessage = null;

      // Existing linked items from backend
      this.linkedItems = [];

      // Data for new link mapping step
      this.newLinkData = null; // { public_token, institution_name, accounts }
      this.accountMappings = {}; // plaid_account_id -> financier_account_id or 'CREATE_NEW' or 'IGNORE'

      // Available Financier accounts to map to
      this.financierAccounts = $scope.manager.accounts.filter((a) => !a.closed);

      /**
       * Fetch status of linked accounts from backend
       */
      this.loadLinkedAccounts = function () {
        that.loading = true;
        that.error = null;

        return plaidLink
          .getAccounts(budgetId)
          .then((res) => {
            that.linkedItems = res.accounts || [];
          })
          .catch((err) => {
            console.error("Failed to load Plaid accounts:", err);
            that.error =
              err.data?.error || "Failed to load bank connection status.";
          })
          .finally(() => {
            that.loading = false;
          });
      };

      /**
       * Start the Plaid Link flow
       */
      this.startPlaidLink = function () {
        that.loading = true;
        that.error = null;

        plaidLink
          .createLinkToken(budgetId)
          .then((res) => {
            return plaidLink.openLink(res.link_token);
          })
          .then(({ public_token, metadata }) => {
            // User completed Plaid Link widget
            const accounts = metadata.accounts || [];
            const institutionName =
              metadata.institution?.name || "Bank Account";

            // Initialize default mappings
            const defaultMappings = {};
            accounts.forEach((acc) => {
              // Try to find a matching existing Financier account by name
              const match = that.financierAccounts.find(
                (fa) =>
                  fa.name.toLowerCase().includes(acc.name.toLowerCase()) ||
                  acc.name.toLowerCase().includes(fa.name.toLowerCase())
              );
              defaultMappings[acc.id] = match ? match.id : "CREATE_NEW";
            });

            that.newLinkData = {
              public_token,
              institutionName,
              accounts,
            };
            that.accountMappings = defaultMappings;
            that.step = "MAP_ACCOUNTS";
          })
          .catch((err) => {
            if (err && err.cancelled) {
              // User closed Plaid Link modal — harmless
              return;
            }
            console.error("Plaid Link error:", err);
            that.error =
              err?.display_message ||
              err?.data?.error ||
              "Failed to complete bank linking.";
          })
          .finally(() => {
            that.loading = false;
          });
      };

      /**
       * Save account mappings and exchange token
       */
      this.saveMappingsAndLink = function () {
        if (!that.newLinkData) return;

        that.loading = true;
        that.error = null;

        const promises = [];
        const finalMappings = [];

        // Process each account mapping
        that.newLinkData.accounts.forEach((acc) => {
          const selectedOption = that.accountMappings[acc.id];

          if (selectedOption === "IGNORE") {
            // User chose not to sync this account
            return;
          }

          if (selectedOption === "CREATE_NEW") {
            // Automatically create a new Financier account for this bank account
            const newAccount = new Account({
              name: `${that.newLinkData.institutionName} - ${acc.name}`,
              type: acc.type === "credit" ? "CREDIT" : "DEBIT",
              onBudget: true,
            });

            // Subscribe and add account to manager
            newAccount.subscribe($scope.myBudget.put);
            $scope.manager.addAccount(newAccount);
            $scope.myBudget.put(newAccount);

            finalMappings.push({
              plaid_account_id: acc.id,
              financier_account_id: newAccount.id,
            });
          } else {
            // Mapped to existing Financier account ID
            finalMappings.push({
              plaid_account_id: acc.id,
              financier_account_id: selectedOption,
            });
          }
        });

        // Refresh accounts list
        $scope.dbCtrl.filterAccounts();

        // Exchange public_token for access_token on backend
        plaidLink
          .exchangeToken(
            that.newLinkData.public_token,
            budgetId,
            finalMappings
          )
          .then(() => {
            that.successMessage = `Successfully linked ${that.newLinkData.institutionName}! Initializing first sync...`;
            that.step = "MANAGE";
            that.newLinkData = null;

            // Trigger initial transaction sync immediately
            return that.triggerSync();
          })
          .catch((err) => {
            console.error("Token exchange failed:", err);
            that.error =
              err.data?.error || "Failed to save bank connection.";
          })
          .finally(() => {
            that.loading = false;
            that.loadLinkedAccounts();
          });
      };

      /**
       * Trigger manual transaction sync for linked accounts
       */
      this.triggerSync = function (itemId) {
        that.syncing = true;
        that.error = null;

        return plaidLink
          .sync(budgetId, itemId)
          .then((res) => {
            let totalAdded = 0;
            if (res.items) {
              res.items.forEach((item) => {
                totalAdded += item.added || 0;
              });
            }
            that.successMessage = `Sync complete! ${totalAdded} new transaction(s) imported.`;
            $scope.$broadcast("pouchdb:change");
          })
          .catch((err) => {
            console.error("Sync error:", err);
            that.error = err.data?.error || "Failed to sync transactions.";
          })
          .finally(() => {
            that.syncing = false;
            that.loadLinkedAccounts();
          });
      };

      /**
       * Remove a linked bank connection
       */
      this.unlinkItem = function (itemId, name) {
        if (
          !confirm(
            `Are you sure you want to unlink ${name || "this bank connection"}?`
          )
        ) {
          return;
        }

        that.loading = true;
        plaidLink
          .unlink(itemId, budgetId)
          .then(() => {
            that.successMessage = "Bank connection unlinked.";
            that.loadLinkedAccounts();
          })
          .catch((err) => {
            console.error("Unlink error:", err);
            that.error = err.data?.error || "Failed to unlink account.";
            that.loading = false;
          });
      };

      // Initial load on modal open
      this.loadLinkedAccounts();
    }
  );
