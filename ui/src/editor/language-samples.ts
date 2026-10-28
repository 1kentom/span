import type { LanguageId } from "./languages";

/**
 * Short, realistic snippets for the languages added with broad language coverage.
 * Highlighting only: these languages have no completions or language servers yet.
 * `file` is a typical file name, used where a sample needs a path to resolve its grammar.
 */
export const LANGUAGE_SAMPLES: Partial<Record<LanguageId, { file: string; code: string }>> = {
  go: { file: "main.go", code: `package main

import (
	"fmt"
	"net/http"
)

// Server answers health checks.
type Server struct {
	Addr string
	hits int
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.hits++
	fmt.Fprintf(w, "ok %d\\n", s.hits)
}

func main() {
	srv := &Server{Addr: ":8080"}
	if err := http.ListenAndServe(srv.Addr, srv); err != nil {
		panic(err)
	}
}
` },
  gomod: { file: "go.mod", code: `module example.com/span/tool

go 1.22

require (
	github.com/spf13/cobra v1.8.0
	golang.org/x/sync v0.6.0 // indirect
)

replace example.com/local => ../local
` },
  c: { file: "list.c", code: `#include <stdio.h>
#include <stdlib.h>

#define MAX_ITEMS 64

typedef struct node {
    int value;
    struct node *next;
} node_t;

static node_t *push(node_t *head, int value) {
    node_t *n = malloc(sizeof *n);
    if (!n) return head; /* out of memory */
    n->value = value;
    n->next = head;
    return n;
}

int main(void) {
    node_t *list = NULL;
    for (int i = 0; i < MAX_ITEMS; i++) list = push(list, i * 2);
    printf("first: %d\\n", list->value);
    return 0;
}
` },
  cpp: { file: "cache.cpp", code: `#include <string>
#include <unordered_map>

namespace span {

template <typename Key, typename Value>
class Cache {
public:
    explicit Cache(std::size_t capacity) : capacity_(capacity) {}

    const Value *find(const Key &key) const {
        auto it = items_.find(key);
        return it == items_.end() ? nullptr : &it->second;
    }

private:
    std::size_t capacity_;
    std::unordered_map<Key, Value> items_;
};

}  // namespace span
` },
  csharp: { file: "Program.cs", code: `using System;
using System.Linq;

namespace Span.Tools;

public record Item(string Name, int Count);

public class Report
{
    private readonly List<Item> _items = new();

    public async Task<int> TotalAsync()
    {
        await Task.Delay(10);
        return _items.Where(i => i.Count > 0).Sum(i => i.Count);
    }

    public static void Main(string[] args) => Console.WriteLine($"items: {args.Length}");
}
` },
  kotlin: { file: "Main.kt", code: `package com.example.span

import kotlinx.coroutines.delay

data class User(val id: Int, val name: String?)

sealed interface Result {
    object Loading : Result
    data class Ok(val users: List<User>) : Result
}

suspend fun load(ids: List<Int>): Result {
    delay(100)
    val users = ids.map { User(it, "user$it") }
    return Result.Ok(users)
}

fun main() = println("hello")
` },
  swift: { file: "Store.swift", code: `import Foundation

struct Note: Identifiable, Codable {
    let id: UUID
    var title: String
    var body: String?
}

final class Store: ObservableObject {
    @Published private(set) var notes: [Note] = []

    func add(_ title: String) {
        guard !title.isEmpty else { return }
        notes.append(Note(id: UUID(), title: title, body: nil))
    }
}
` },
  php: { file: "index.php", code: `<?php
declare(strict_types=1);

namespace App\\Http;

use App\\Models\\User;

final class UserController
{
    public function __construct(private readonly UserRepository $users) {}

    public function show(int $id): array
    {
        $user = $this->users->find($id) ?? throw new \\RuntimeException("missing");
        // Return a plain array for JSON encoding
        return ['id' => $user->id, 'name' => $user->name];
    }
}
` },
  ruby: { file: "app.rb", code: `require "json"

module Span
  # Loads settings from disk.
  class Config
    attr_reader :path

    def initialize(path = "span.json")
      @path = path
    end

    def load
      data = JSON.parse(File.read(path), symbolize_names: true)
      data.fetch(:theme, "dark")
    rescue Errno::ENOENT => e
      warn "missing: #{e.message}"
      nil
    end
  end
end
` },
  sql: { file: "report.sql", code: `-- Orders per customer in the last 30 days
SELECT c.id,
       c.name,
       COUNT(o.id) AS orders,
       SUM(o.total) AS revenue
FROM customers AS c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.created_at >= NOW() - INTERVAL '30 days'
  AND c.status = 'active'
GROUP BY c.id, c.name
HAVING COUNT(o.id) > 3
ORDER BY revenue DESC
LIMIT 10;
` },
  xml: { file: "pom.xml", code: `<?xml version="1.0" encoding="UTF-8"?>
<!-- Build descriptor -->
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>span-demo</artifactId>
  <version>1.0.0</version>
  <properties>
    <java.version>21</java.version>
  </properties>
  <dependencies>
    <dependency scope="test">
      <artifactId>junit</artifactId>
    </dependency>
  </dependencies>
</project>
` },
  dockerfile: { file: "Dockerfile", code: `# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:1.27-alpine
ENV PORT=8080
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
` },
  makefile: { file: "Makefile", code: `CC := gcc
CFLAGS ?= -O2 -Wall
SRC = $(wildcard src/*.c)
OBJ = $(SRC:.c=.o)

.PHONY: all clean

all: app

app: $(OBJ)
	$(CC) $(CFLAGS) -o $@ $^

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

# remove build output
clean:
	rm -f app $(OBJ)
` },
  cmake: { file: "CMakeLists.txt", code: `cmake_minimum_required(VERSION 3.20)
project(span VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
add_executable(span src/main.cpp)
target_link_libraries(span PRIVATE fmt::fmt)
# tests
if(BUILD_TESTING)
  add_subdirectory(tests)
endif()
` },
  lua: { file: "init.lua", code: `local M = {}

-- Greets someone by name.
function M.greet(name, times)
  times = times or 1
  for i = 1, times do
    print(("hello %s #%d"):format(name, i))
  end
  return #name > 0
end

local config = { theme = "dark", size = 14, wrap = false }
return M
` },
  yaml: { file: "ci.yml", code: `name: ci
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Test
        run: cargo test --release
        env:
          RUST_LOG: info # verbose
` },
  terraform: { file: "main.tf", code: `terraform {
  required_version = ">= 1.6"
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

# One bucket per environment
resource "aws_s3_bucket" "assets" {
  bucket = "span-\${var.region}-assets"
  tags = {
    Environment = "prod"
    Count       = 3
  }
}
` },
  graphql: { file: "schema.graphql", code: `# Users and posts
type User {
  id: ID!
  name: String!
  posts(first: Int = 10): [Post!]!
}

query GetUser($id: ID!) {
  user(id: $id) @cached {
    name
    posts { title }
  }
}
` },
  powershell: { file: "build.ps1", code: `param([string]$Configuration = "Release")

# Build every project
$projects = Get-ChildItem -Path . -Filter *.csproj -Recurse
foreach ($project in $projects) {
    Write-Host "Building $($project.Name)"
    dotnet build $project.FullName -c $Configuration
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
}
` },
  batch: { file: "build.bat", code: `@echo off
REM Build the project
setlocal
set CONFIG=Release
if not exist dist mkdir dist
call npm run build -- --mode %CONFIG%
if errorlevel 1 goto :fail
echo done
exit /b 0
:fail
echo build failed
exit /b 1
` },
  zig: { file: "main.zig", code: `const std = @import("std");

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();
    var count: u32 = 0;
    while (count < 3) : (count += 1) {
        try stdout.print("hello {d}\\n", .{count});
    }
}
` },
  scala: { file: "Main.scala", code: `package com.example

case class Point(x: Int, y: Int)

object Main extends App {
  val points = List(Point(1, 2), Point(3, 4))
  // Sum the x coordinates
  val total = points.map(_.x).sum
  println(s"total = $total")
}
` },
  dart: { file: "main.dart", code: `import 'package:flutter/material.dart';

class Counter extends StatefulWidget {
  const Counter({super.key});

  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _count = 0;
  void _inc() => setState(() => _count++);
}
` },
  haskell: { file: "Main.hs", code: `module Main where

import Data.List (sortBy)

-- | A simple pair.
data Pair a = Pair a a deriving (Show, Eq)

total :: [Int] -> Int
total = foldr (+) 0

main :: IO ()
main = print (total [1, 2, 3])
` },
  elixir: { file: "app.ex", code: `defmodule Span.Greeter do
  @moduledoc "Greets people."

  def greet(name) when is_binary(name) do
    # Build the message
    "Hello, #{name}!"
  end

  def run, do: IO.puts(greet("span"))
end
` },
  ini: { file: "settings.ini", code: `; editor settings
[editor]
font_size = 14
theme = dark
word_wrap = true

[paths]
workspace = /home/user/code
` },
  proto: { file: "service.proto", code: `syntax = "proto3";

package span.v1;

// A greeting request.
message HelloRequest {
  string name = 1;
  repeated string tags = 2;
}

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
}
` },
  diff: { file: "change.patch", code: `diff --git a/src/main.rs b/src/main.rs
index 83db48f..bf2a1c0 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,4 +1,5 @@
 fn main() {
-    println!("hello");
+    let name = "span";
+    println!("hello {name}");
 }
` },
  perl: { file: "script.pl", code: `use strict;
use warnings;

my %counts;
# Count words on stdin
while (my $line = <STDIN>) {
    $counts{$_}++ for split /\\s+/, $line;
}
print "$_: $counts{$_}\\n" for sort keys %counts;
` },
  r: { file: "plot.R", code: `library(ggplot2)

# Fit a simple model
data <- data.frame(x = 1:10, y = c(2.1, 3.9, 6.2, 8.1, 9.8, 12.2, 13.9, 16.1, 18.0, 20.2))
model <- lm(y ~ x, data = data)
summary(model)
ggplot(data, aes(x, y)) + geom_point() + geom_smooth(method = "lm")
` },
  groovy: { file: "build.gradle", code: `plugins {
    id 'java'
}

repositories {
    mavenCentral()
}

// Test dependencies
dependencies {
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'
}

tasks.register('hello') {
    doLast { println "hello" }
}
` },
  objectivec: { file: "Greeter.m", code: `#import <Foundation/Foundation.h>

@interface Greeter : NSObject
- (NSString *)greet:(NSString *)name;
@end

@implementation Greeter
- (NSString *)greet:(NSString *)name {
    // Build the greeting
    return [NSString stringWithFormat:@"Hello, %@", name];
}
@end
` },
  erlang: { file: "greeter.erl", code: `-module(greeter).
-export([greet/1]).

%% Greets by name.
greet(Name) when is_list(Name) ->
    io:format("Hello, ~s!~n", [Name]),
    ok.
` },
  clojure: { file: "core.clj", code: `(ns span.core
  (:require [clojure.string :as str]))

;; Shout a greeting
(defn greet [name]
  (str "Hello, " (str/upper-case name) "!"))

(def names ["ada" "grace"])
(doseq [n names] (println (greet n)))
` },
  less: { file: "theme.less", code: `@accent: #4a90d9;

.button {
  color: @accent;
  &:hover { color: darken(@accent, 10%); }
  // rounded corners
  border-radius: 4px;
}
` },
};
