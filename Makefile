VERSION := 2.0.0
GO ?= go

.PHONY: build test clean

build:
	mkdir -p dist
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o dist/ompi ./cli/cmd/ompi

test:
	OMPI_USAGE=0 $(GO) test ./...
	OMPI_USAGE=0 node --test

clean:
	rm -rf dist
