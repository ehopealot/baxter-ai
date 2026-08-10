# Tests for the codapi docker-socket authz policy. Each of the reviewer-found
# holes (blind rounds 1-4) is a regression case here. Run: `opa test .`
package docker.authz

# a legitimate constrained create body (correct image + runtime, capped, one ro CODAPI_TMP bind)
legit_hc = {
	"Privileged": false,
	"Runtime": "runsc",
	"Memory": 536870912,
	"PidsLimit": 64,
	"NanoCpus": 1000000000,
	"Binds": ["/var/tmp/baxter-codapi/run123:/sandbox:ro"],
}

create(hc, img, path) = {"Method": "POST", "Path": path, "Body": {"Image": img, "HostConfig": hc}}

good_path = "/v1.43/containers/create?name=x" # version prefix AND query string

# --- legitimate creates are allowed ---
test_allow_legit_create {
	allow with input as create(legit_hc, "codapi/python", good_path)
}

test_allow_legit_node {
	allow with input as create(legit_hc, "codapi/node", good_path)
}

# docker sends "Binds": null for a bindless run -> must still be allowed (fail-open? no, fail-CLOSED was the bug)
test_allow_legit_null_binds {
	allow with input as create(object.union(legit_hc, {"Binds": null}), "codapi/python", good_path)
}

# no Binds key at all
test_allow_legit_absent_binds {
	allow with input as create({"Privileged": false, "Runtime": "runsc", "Memory": 536870912, "PidsLimit": 64, "NanoCpus": 1000000000}, "codapi/python", good_path)
}

# --- gVisor runtime: no downgrade out of the sandbox kernel boundary ---
test_deny_runtime_runc {
	not allow with input as create(object.union(legit_hc, {"Runtime": "runc"}), "codapi/python", good_path)
}

# absent Runtime = daemon default (could be runc) -> deny; codapi always names runsc
test_deny_runtime_absent {
	not allow with input as create({"Privileged": false, "Memory": 536870912, "PidsLimit": 64, "NanoCpus": 1000000000, "Binds": legit_hc.Binds}, "codapi/python", good_path)
}

# --- round 2: query string must not fail open (the $-anchored-matcher bug) ---
test_deny_privileged_with_query {
	not allow with input as create(object.union(legit_hc, {"Privileged": true}), "codapi/python", good_path)
}

# --- privileged / host namespaces ---
test_deny_privileged {
	not allow with input as create(object.union(legit_hc, {"Privileged": true}), "codapi/python", "/v1.43/containers/create")
}

test_deny_host_pid {
	not allow with input as create(object.union(legit_hc, {"PidMode": "host"}), "codapi/python", good_path)
}

test_deny_host_net {
	not allow with input as create(object.union(legit_hc, {"NetworkMode": "host"}), "codapi/python", good_path)
}

test_deny_host_ipc {
	not allow with input as create(object.union(legit_hc, {"IpcMode": "host"}), "codapi/python", good_path)
}

# --- image allowlist ---
test_deny_foreign_image {
	not allow with input as create(legit_hc, "alpine", good_path)
}

# --- round 4: caps must be present AND bounded ---
test_deny_uncapped_missing_memory {
	not allow with input as create({"Privileged": false, "PidsLimit": 64, "NanoCpus": 1000000000, "Binds": legit_hc.Binds}, "codapi/python", good_path)
}

test_deny_over_capped_memory {
	not allow with input as create(object.union(legit_hc, {"Memory": 68719476736}), "codapi/python", good_path) # 64g
}

test_deny_over_capped_pids {
	not allow with input as create(object.union(legit_hc, {"PidsLimit": 4194304}), "codapi/python", good_path)
}

# round 5 (found during opa-test build): Memory capped but MemorySwap unlimited
test_deny_unlimited_swap {
	not allow with input as create(object.union(legit_hc, {"MemorySwap": -1}), "codapi/python", good_path)
}

# --- round 3: Mounts (--mount) bypass of the Binds checks ---
test_deny_mount_bind {
	not allow with input as create(object.union(legit_hc, {"Mounts": [{"Type": "bind", "Source": "/etc", "Target": "/etc", "ReadOnly": false}]}), "codapi/python", good_path)
}

# --- bind hardening: traversal + :rw ---
test_deny_bind_traversal {
	not allow with input as create(object.union(legit_hc, {"Binds": ["/var/tmp/../../etc:/x:ro"]}), "codapi/python", good_path)
}

test_deny_bind_rw {
	not allow with input as create(object.union(legit_hc, {"Binds": ["/var/tmp/baxter-codapi/run123:/sandbox:rw"]}), "codapi/python", good_path)
}

test_deny_bind_outside_tmp {
	not allow with input as create(object.union(legit_hc, {"Binds": ["/etc:/sandbox:ro"]}), "codapi/python", good_path)
}

# --- default-deny: an unlisted endpoint (e.g. image build, container exec) ---
test_deny_unlisted_build {
	not allow with input as {"Method": "POST", "Path": "/v1.43/build", "Body": {}}
}

test_deny_unlisted_exec {
	not allow with input as {"Method": "POST", "Path": "/v1.43/containers/abc/exec", "Body": {}}
}

# --- lifecycle codapi needs is allowed ---
test_allow_start {
	allow with input as {"Method": "POST", "Path": "/v1.43/containers/abc/start", "Body": {}}
}

test_allow_wait {
	allow with input as {"Method": "POST", "Path": "/v1.43/containers/abc/wait", "Body": {}}
}

test_allow_logs {
	allow with input as {"Method": "GET", "Path": "/v1.43/containers/abc/logs?stdout=1", "Body": {}}
}

test_allow_delete {
	allow with input as {"Method": "DELETE", "Path": "/v1.43/containers/abc?force=1", "Body": {}}
}

test_allow_ping {
	allow with input as {"Method": "GET", "Path": "/_ping", "Body": {}}
}
