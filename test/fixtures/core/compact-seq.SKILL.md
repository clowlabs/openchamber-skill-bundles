---
name: ethos-explore
description: Define an AI agent's purpose, boundaries, and priorities.
triggers:
- design my agent
- what should my agent do
- help me think through the agent
- I want to build an agent
- agent design
- explore the agent
- figure out what my agent needs
- write an ethos.md for my agent
- onboard my existing agent
not-for:
- ethos-write (use to write or edit the ethos.md file once explore is done)
- ethos-orchestrate (use to choose between exploring and writing an ethos.md)
- superpowers:brainstorming (use for design work that is not about an agent's 
  intended behavior)
compatibility: Dialogue-driven with read-only pre-flight (`ls`, `find`, `Read`);
  one intent question per message after the codebase scan; at least three 
  questions covering Purpose & Outcomes, Principles, and Vision; safe under any 
  sandbox; works offline; output is a structured conversation handed to 
  ethos-write.
license: Apache-2.0
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash
---

# Ethos explore

Body.
