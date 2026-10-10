.PHONY: install build test lint typecheck clean

install:
	npm ci

build:
	npm run build

test:
	npm test

lint:
	npm run lint

typecheck:
	npm run typecheck

clean:
	rm -rf node_modules dist .expo