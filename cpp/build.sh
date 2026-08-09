#!/bin/sh
cd "$(dirname "$0")" && exec clang++ -O2 -std=c++17 -Wall main.cpp -lcurl -o hero-run-mcp
