# codapi docker-socket authorization policy (for opa-docker-authz on the rootless
# daemon codapi drives -- see app/docs/architecture/codapi-hardening-ops.md).
#
# DEFAULT-DENY: only the exact API calls codapi needs are allowed, and
# /containers/create is constrained so a COMPROMISED codapi crafting its own
# request body cannot escape (no privileged, no host namespaces, only our sandbox
# images, only read-only CODAPI_TMP binds, no --mount, and resource caps bounded
# to codapi.json's values).
#
# Classic Rego (no future.keywords) so it loads on the older OPA embedded in
# opa-docker-authz-v2. Tested with `opa test` (codapi-authz_test.rego).
#
# INPUT SCHEMA (opa-docker-authz v2): input.Method (HTTP verb), input.Path (the
# full RequestURI -- includes the /vX.Y version prefix AND any ?query), input.Body
# (the parsed JSON request body). The schema binding is the ONE thing opa test
# cannot verify -- confirm with a live deny/allow against your plugin version
# (runbook step 4). If your plugin exposes different field names, change them
# ONLY in the accessors at the top.

package docker.authz

default allow = false

# --- input accessors (adjust here if your opa-docker-authz schema differs) ---
method = input.Method
reqpath = input.Path
body = input.Body

# --- helpers ---
# normalize a null / missing / non-array value to [] (docker sends "Binds": null
# for a bindless create, so object defaults don't apply and iteration is undefined)
arr(x) = x { is_array(x) }
arr(x) = [] { not is_array(x) }

# query-tolerant suffix match: docker passes the full RequestURI, e.g.
# /v1.43/containers/create?name=x -- a $-anchored match would miss the ?query and
# fail open, so match the suffix followed by `?` or end-of-string.
path_suffix(s) { regex.match(sprintf("%s(\\?|$)", [s]), reqpath) }
path_re(re) { regex.match(re, reqpath) }

host_ns(m) { m == "host" }
allowed_image(img) { img == "codapi/python" }
allowed_image(img) { img == "codapi/node" }

# resource caps must be PRESENT and WITHIN codapi.json's ceilings -- a presence
# check alone is bypassed by a malicious client sending huge values.
capped(hc) {
	hc.Memory > 0
	hc.Memory <= 536870912 # 512 MiB == codapi.json "memory"
	hc.PidsLimit > 0
	hc.PidsLimit <= 64 # == codapi.json "nproc"
	hc.NanoCpus > 0
	hc.NanoCpus <= 1000000000 # 1 cpu == codapi.json "cpu"
	# MemorySwap: -1 (unlimited) reopens the memory-DoS path even with Memory
	# capped; 0 = daemon default (2x Memory). Bound it and exclude negatives.
	msw := object.get(hc, "MemorySwap", 0)
	msw >= 0
	msw <= 1073741824
}

# a bind must be under CODAPI_TMP, read-only, and free of traversal.
# Replace the prefix with the box's real /var/tmp/<project>-codapi/ .
allowed_bind(b) {
	startswith(b, "/var/tmp/")
	not contains(b, "..")
	endswith(b, ":ro")
}

# true if ANY bind is disallowed (so the create rule can require `not bad_bind`).
# object.get covers an ABSENT key; arr() covers an explicit null / non-array.
bad_bind(hc) {
	b := arr(object.get(hc, "Binds", []))[_]
	not allowed_bind(b)
}

# --- the security-critical rule: constrained container creation ---
allow {
	method == "POST"
	path_suffix("/containers/create")
	hc := body.HostConfig
	# object.get defaults so an ABSENT key is a DEFINED value -- `not host_ns(hc.X)`
	# with an undefined hc.X fails the whole rule (denies legit creates that omit
	# these keys, which is all of them). This is a fail-CLOSED trap opa test caught.
	not object.get(hc, "Privileged", false)
	not host_ns(object.get(hc, "PidMode", ""))
	not host_ns(object.get(hc, "NetworkMode", ""))
	not host_ns(object.get(hc, "IpcMode", ""))
	allowed_image(body.Image)
	capped(hc)
	count(arr(object.get(hc, "Mounts", []))) == 0 # codapi uses Binds, not --mount; a --mount would bypass allowed_bind
	not bad_bind(hc)
}

# --- other lifecycle calls codapi needs (default-deny for everything else).
# TUNE this list to codapi's ACTUAL calls (observe the plugin debug log). ---
allow {
	method == "POST"
	path_re(`/containers/[^/?]+/(start|wait|kill|stop)(\?|$)`)
}

allow {
	method == "POST"
	path_re(`/containers/[^/?]+/attach(\?|$)`)
}

allow {
	method == "DELETE"
	path_re(`/containers/[^/?]+(\?|$)`)
}

allow {
	method == "GET"
	path_re(`/containers/[^/?]+/(logs|json|wait)(\?|$)`)
}

allow {
	method == "GET"
	path_re(`/(_ping|version|images/[^/?]+/json)(\?|$)`)
}
