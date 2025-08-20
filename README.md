# 3suite-network-multiplexer

network-multiplexer groups multiple identical HTTP endpoints under a single URL. it allows distributing HTTP requests to multiple servers, limiting concurrent requests per server.

network-multiplexer is primarily useful for scenarios where arbitrary horizontal scaling is needed--especially when nodes can only handle a single request at once.

## usage

most settings should be self-evident from `config.json5`. for advanced configuration information, see [3lib-config](https://github.com/3sig/3lib-config)

network-multiplexer processes a range of headers from the input request as well. these headers will not be passed to the server if they are provided.

- `3suite-priority`: sets the priority for this request in the queue. requests with higher priorities will be assigned empty slots first. the default priority is 0
- `3suite-bundle-id`, `3suite-bundle-size`, `3suite-bundle-order`: use these headers to group requests if they are supposed to go to the same server. requests will be bundled by `3suite-bundle-id`, and only executed once the number of requests in the bundle reaches `3suite-bundle-size`. `3suite-bundle-order` dictates the order in which the requests will be executed, and is optional. if `3suite-bundle-order` is not provided, the requests will be executed in the order they were received.

### creating a release

ensure that you are in a fully committed state before creating a tag.
run `npm run release` (or `bun run release`) and follow the prompts.

### macOS builds

we currently do not support notarization for macOS builds.
to run mac builds, flag them as safe for gatekeeper with the following command:

`xattr -c <path_to_mac_executable>`
