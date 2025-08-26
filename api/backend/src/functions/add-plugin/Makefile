build-addPluginFunction:
	cp ./package.json $(ARTIFACTS_DIR)
	npm install --prefix $(ARTIFACTS_DIR)
	npm run-script build --prefix $(ARTIFACTS_DIR)
	rm -rf $(ARTIFACTS_DIR)/package.json