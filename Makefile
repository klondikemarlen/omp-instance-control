VERSION := 0.2.0
GO ?= go

.PHONY: build test clean

build:
	mkdir -p dist
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o dist/ompi ./cli/cmd/ompi

test:
	$(GO) test ./...
	node --test

clean:
	rm -rf dist
