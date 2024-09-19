VERSION := $(shell git describe --tags --always)
MODULEJS := less-chat.js

all: dist/module.json dist/$(MODULEJS) dist/lang/en.json

package: module.zip

clean:
	rm -rf dist

.PHONY: all package clean

module.zip: all
	cd dist && zip -r ../$@ .

dist:
	mkdir -p dist

dist/lang: | dist
	mkdir -p dist/lang

dist/module.json: static/module.json | dist
	sed -e 's/@TAG@/$(VERSION)/' -e 's/@VERSION@/$(patsubst v%,%,$(VERSION))/' -e 's/@MODULEJS@/$(MODULEJS)/' $< > $@

dist/lang/%: static/lang/% | dist/lang
	cp $< $@

dist/%.js: src/%.js | dist
	npx rollup $< --file $@ --format es --generatedCode es2015
