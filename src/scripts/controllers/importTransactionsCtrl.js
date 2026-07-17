import Papa from "papaparse";
import moment from "moment";

angular
  .module("financier")
  .controller(
    "importTransactionsCtrl",
    function ($rootScope, $scope, $stateParams, $q, payee, transaction, db) {
      const budgetId = $stateParams.budgetId;
      const Payee = payee(budgetId);
      const Transaction = transaction(budgetId);

      this.step = 1;
      this.selectedAccountId = $scope.accountId || null;
      this.file = null;
      this.parsing = false;
      this.error = null;
      this.parsedTransactions = [];
      this.uniquePayees = [];
      this.existingPayees = [];
      this.savedMappings = {};

      // Expose list of accounts for selection
      this.accounts = $scope.dbCtrl.accounts.filter(a => !a.closed);

      // Load existing payees
      const loadExistingPayees = () => {
        this.existingPayees = Object.keys($scope.payees)
          .map(id => $scope.payees[id])
          .filter(p => !p.internal && !p.data._deleted)
          .sort((a, b) => a.name.localeCompare(b.name));
      };
      loadExistingPayees();

      // Load persistent mappings from database
      const docId = `b_${budgetId}_import_mappings`;
      db._pouch
        .get(docId)
        .then(doc => {
          this.savedMappings = doc.mappings || {};
        })
        .catch(() => {
          // 404 is normal for first time
          this.savedMappings = {};
        });

      // Watch file selection
      $scope.$watch(() => this.file, (newFile) => {
        if (newFile) {
          this.parseCSV(newFile);
        }
      });

      this.parseCSV = (file) => {
        this.parsing = true;
        this.error = null;
        this.parsedTransactions = [];
        this.uniquePayees = [];

        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (header) => header.trim(),
          complete: (results) => {
            $scope.$apply(() => {
              this.parsing = false;
              if (results.errors && results.errors.length > 0 && results.data.length === 0) {
                this.error = "Error parsing CSV file. Please check file format.";
                return;
              }

              const rows = results.data;
              const transactions = [];
              const rawPayeesMap = {};

              const findValue = (row, keys) => {
                for (let key of keys) {
                  if (row[key] !== undefined && row[key] !== null) {
                    return row[key];
                  }
                }
                return "";
              };

              for (let row of rows) {
                const rawDate = findValue(row, ["Date", "date", "DATE"]);
                const rawPayee = findValue(row, [
                  "Transaction Details",
                  "Payee",
                  "payee",
                  "Description",
                  "description",
                  "PAYEE",
                  "Memo",
                  "memo",
                  "MEMO",
                ]);
                const rawOutflow = findValue(row, ["Funds Out", "Outflow", "outflow", "Spend", "OUTFLOW"]);
                const rawInflow = findValue(row, ["Funds In", "Inflow", "inflow", "Receive", "INFLOW"]);
                const rawAmount = findValue(row, ["Amount", "amount", "Value", "value", "AMOUNT"]);

                if (!rawDate || !rawPayee) {
                  continue;
                }

                const date = moment(rawDate.trim(), ["MM/DD/YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "M/D/YYYY", "D/M/YYYY"]);
                if (!date.isValid()) {
                  continue;
                }

                let inflow = 0;
                let outflow = 0;

                if (rawOutflow || rawInflow) {
                  outflow = Math.round(parseFloat((rawOutflow || "0").replace(/[$,]/g, "")) * 100) || 0;
                  inflow = Math.round(parseFloat((rawInflow || "0").replace(/[$,]/g, "")) * 100) || 0;
                } else if (rawAmount) {
                  const amt = parseFloat(rawAmount.replace(/[$,]/g, "")) || 0;
                  if (amt < 0) {
                    outflow = Math.round(Math.abs(amt) * 100);
                  } else {
                    inflow = Math.round(amt * 100);
                  }
                }

                const value = inflow - outflow;
                const trimmedPayee = rawPayee.trim();

                transactions.push({
                  date: date.toDate(),
                  rawPayee: trimmedPayee,
                  inflow,
                  outflow,
                  value,
                });

                if (trimmedPayee) {
                  rawPayeesMap[trimmedPayee] = true;
                }
              }

              if (transactions.length === 0) {
                this.error = "No valid transactions found in the file.";
                return;
              }

              this.parsedTransactions = transactions;

              // Generate unique payees list for mapping step
              const uniqueNames = Object.keys(rawPayeesMap).sort();
              this.uniquePayees = uniqueNames.map(name => {
                const cleaned = cleanPayeeName(name);
                
                // Determine pre-selected payee
                let payeeId = "NEW";
                let saved = this.savedMappings[name];
                
                if (saved && $scope.payees[saved] && !$scope.payees[saved].data._deleted) {
                  payeeId = saved;
                } else {
                  const suggested = suggestPayee(cleaned, this.existingPayees);
                  if (suggested) {
                    payeeId = suggested;
                  }
                }

                // Get all amounts for this raw payee to help decide
                const txnsForPayee = transactions.filter(t => t.rawPayee === name);
                const amountsString = txnsForPayee.map(t => {
                  const val = t.value;
                  const decimalVal = (Math.abs(val) / 100).toFixed(2);
                  return (val < 0 ? "-" : "+") + "$" + decimalVal;
                }).join(", ");

                return {
                  rawName: name,
                  cleanedName: cleaned,
                  payeeId: payeeId,
                  remember: true,
                  amounts: amountsString,
                };
              });

              this.goToStep2();
            });
          },
          error: (err) => {
            $scope.$apply(() => {
              this.parsing = false;
              this.error = err.message || "Failed to read CSV file.";
            });
          },
        });
      };

      this.goToStep2 = () => {
        if (this.uniquePayees.length > 0) {
          this.step = 2;
        }
      };

      this.goToStep3 = () => {
        // Resolve payee names for final confirmation step
        const mappingMap = {};
        for (let mapping of this.uniquePayees) {
          mappingMap[mapping.rawName] = mapping;
        }

        const selectedAccount = this.accounts.find(a => a.id === this.selectedAccountId);
        const existingTxns = selectedAccount ? selectedAccount.transactions : [];

        this.finalTransactions = this.parsedTransactions.map(t => {
          const mapping = mappingMap[t.rawPayee] || {};
          let payeeName = "";
          let categoryId = null;

          if (mapping.payeeId === "NEW") {
            payeeName = mapping.cleanedName;
          } else {
            const p = $scope.payees[mapping.payeeId];
            payeeName = p ? p.name : "";
            categoryId = p ? p.categorySuggest : null;
          }

          const categoryName = categoryId ? $scope.dbCtrl.getCategoryName(categoryId, t.date) : "";

          // Check duplicate
          const tTime = t.date.getTime();
          const isDuplicate = existingTxns.some(et => {
            if (et.data._deleted) return false;
            const diffDays = Math.abs(et.date.getTime() - tTime) / (1000 * 60 * 60 * 24);
            return diffDays <= 2 && et.value === t.value;
          });

          return {
            date: t.date,
            rawPayee: t.rawPayee,
            payeeName: payeeName,
            payeeId: mapping.payeeId,
            categoryId: categoryId,
            categoryName: categoryName,
            value: t.value,
            inflow: t.inflow,
            outflow: t.outflow,
            isDuplicate: isDuplicate,
            import: !isDuplicate, // default unchecked for potential duplicates
          };
        });

        this.step = 3;
      };

      this.toggleAllReview = (selectAll) => {
        for (let t of this.finalTransactions) {
          t.import = selectAll;
        }
      };

      this.submit = () => {
        this.loading = true;

        const newPayeePromises = [];
        const newPayeesCreatedMap = {};

        // 1. Create new payees first
        for (let mapping of this.uniquePayees) {
          if (mapping.payeeId === "NEW") {
            const cleanName = mapping.cleanedName;
            
            // Check if we've already created this payee name in a previous iteration to avoid duplicates
            if (newPayeesCreatedMap[cleanName]) {
              mapping.resolvedPayeePromise = newPayeesCreatedMap[cleanName];
            } else {
              const p = new Payee({ name: cleanName });
              
              // We put it in db and add to local payees list
              const promise = $scope.myBudget.put(p).then(() => {
                $scope.payees[p.id] = p;
                return p.id;
              });
              
              newPayeesCreatedMap[cleanName] = promise;
              mapping.resolvedPayeePromise = promise;
              newPayeePromises.push(promise);
            }
          } else {
            mapping.resolvedPayeePromise = $q.resolve(mapping.payeeId);
          }
        }

        // Wait for payees to be created
        $q.all(newPayeePromises)
          .then(() => {
            // Get resolved payee IDs for all mappings
            const resolvePromises = this.uniquePayees.map(mapping => {
              return mapping.resolvedPayeePromise.then(id => {
                mapping.resolvedId = id;
                return { rawName: mapping.rawName, id: id, remember: mapping.remember };
              });
            });

            return $q.all(resolvePromises);
          })
          .then((mappingsList) => {
            const finalMappingsMap = {};
            const mappingsToSave = {};

            for (let m of mappingsList) {
              finalMappingsMap[m.rawName] = m.id;
              if (m.remember) {
                mappingsToSave[m.rawName] = m.id;
              }
            }

            // 2. Save mappings configurations to PouchDB doc
            const docId = `b_${budgetId}_import_mappings`;
            const saveMappingsPromise = db._pouch
              .get(docId)
              .then(doc => {
                doc.mappings = angular.merge({}, doc.mappings || {}, mappingsToSave);
                return db._pouch.put(doc);
              })
              .catch(err => {
                if (err.status === 404) {
                  return db._pouch.put({
                    _id: docId,
                    mappings: mappingsToSave,
                  });
                }
                throw err;
              });

            // 3. Save transactions
            const txnsToImport = this.finalTransactions.filter(t => t.import);
            const txnPromises = txnsToImport.map(t => {
              // Resolve payee id (if new, find mapping's resolved ID)
              const resolvedPayeeId = finalMappingsMap[t.rawPayee] || t.payeeId;

              // Find payee object to get its categorySuggest (if any)
              const pObj = $scope.payees[resolvedPayeeId];
              const categoryId = pObj ? pObj.categorySuggest : null;

              const trans = new Transaction({
                value: t.value,
                date: moment(t.date).format("YYYY-MM-DD"),
                account: this.selectedAccountId,
                payee: resolvedPayeeId,
                category: categoryId,
                memo: t.rawPayee, // Keep raw bank details in memo
                cleared: true,   // Automatically clear imported transactions
              });

              $scope.manager.addTransaction(trans);
              return $scope.myBudget.put(trans);
            });

            return $q.all([...txnPromises, saveMappingsPromise]);
          })
          .then(() => {
            this.loading = false;
            $rootScope.$broadcast("vsRepeatTrigger");
            $scope.closeThisDialog();
          })
          .catch(err => {
            this.loading = false;
            this.error = err.message || "An error occurred during import.";
          });
      };

      // Helper function to clean raw payee name
      function cleanPayeeName(raw) {
        if (!raw) return "";
        let clean = raw.trim();

        const prefixes = [
          /^pos merchandise\s+/i,
          /^pos merch\s+/i,
          /^pos\s+/i,
          /^pre-authorized debit\s+/i,
          /^miscellaneous payments\s+/i,
          /^payroll deposit\s+/i,
          /^eft debit\s+/i,
          /^eft credit\s+/i,
          /^interac e-transfer receive\s+/i,
          /^interac e-transfer send\s+/i,
          /^abm withdrawal/i,
          /^cheque image deposit/i,
          /^cable bill payment\s+/i,
          /^auto insurance\s+/i,
        ];

        for (let prefix of prefixes) {
          clean = clean.replace(prefix, "");
        }

        clean = clean.replace(/\s+cheque\s*$/i, "");
        clean = clean.replace(/\s+\d+\s*$/g, "");
        clean = clean.replace(/\s+c\d+\s*$/i, "");
        clean = clean.replace(/\s+store\s*$/i, "");

        clean = clean.trim();

        // Convert to Title Case
        clean = clean.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

        return clean || raw;
      }

      // Helper to suggest existing payee
      function suggestPayee(cleanName, existingPayees) {
        const cleanLower = cleanName.toLowerCase();

        // 1. Exact match
        for (let ep of existingPayees) {
          if (ep.name.toLowerCase() === cleanLower) {
            return ep.id;
          }
        }

        // 2. Substring match
        for (let ep of existingPayees) {
          const epNameLower = ep.name.toLowerCase();
          if (cleanLower.includes(epNameLower) || epNameLower.includes(cleanLower)) {
            return ep.id;
          }
        }

        return null;
      }
    }
  );
