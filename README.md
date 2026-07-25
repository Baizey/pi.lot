# Pi.dev extension

This is an extension which primarily provides kernel-mediated dynamic interactive policy control when the agent does __anything__

This is in general done through:
- FUSE (2.9 as of fuse-native)
- bubblewrap
- some custom C to mediate

pi.lot turns pi.dev into something that is intended to run across repositories, it does not have a workspace, it works alongside you wherever you are.

This is a v2 of `https://github.com/Baizey/pi-agent-tools`

It is currently in active development

Features:
- path io kernel mediated policy system
- experimental proof-of-concept network io "kernel" mediated policy system
- Basic TUI extending the fold/unfold into minimal/truncated/full view
- 

Features yet to be ported:
- subagents
- web search/read
- session search for the agent
- shell commands policy system

## Limitations and usage

Software is provided as-is

Only Linux is supported