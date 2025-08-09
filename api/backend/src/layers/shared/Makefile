build-shared:
	mkdir -p $(ARTIFACTS_DIR)/nodejs
	cp package.json $(ARTIFACTS_DIR)/nodejs/
	npm install --prefix $(ARTIFACTS_DIR)/nodejs/
	npm run-script build
	rm -rf $(ARTIFACTS_DIR)/nodejs/package.json
	cp -r dist $(ARTIFACTS_DIR)/