#!/usr/bin/env node

/**
 * Post-process doctoc-generated table of contents to fix emoji heading links.
 *
 * Problem: doctoc generates links like (#-overview) for emoji headings like "✨ Overview"
 * Solution: Convert them to (#overview) to match the explicit HTML heading IDs
 *
 * This allows us to use HTML headings with explicit IDs for emoji sections while
 * still auto-generating the TOC structure with doctoc.
 */

import fs from "fs";
import path from "path";

const readmePath = path.join(process.cwd(), "README.md");
let content = fs.readFileSync(readmePath, "utf8");

// Fix doctoc's emoji handling: (#-word) should become (#word)
// This matches the explicit IDs we set on HTML headings
content = content.replace(/\(#-([^)]+)\)/g, "(#$1)");

fs.writeFileSync(readmePath, content);
console.log("TOC links fixed!");
