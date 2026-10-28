import { describe, expect, it } from "vitest";
import { parseSshConfig } from "../../plugins/remote-workbench/client/lib/ssh-config.mjs";

describe("remote-workbench ssh-config parser", () => {
	it("正确解析标准 OpenSSH config 语法", () => {
		const sample = `
# Global defaults
Host *
    ServerAliveInterval 60

Host dev-server
    HostName 10.0.0.12
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host aliyun-prod
    HostName 82.156.246.55
    User root
`;
		const hosts = parseSshConfig(sample);
		expect(hosts).toHaveLength(2);

		expect(hosts[0].alias).toBe("dev-server");
		expect(hosts[0].host).toBe("10.0.0.12");
		expect(hosts[0].username).toBe("deploy");
		expect(hosts[0].port).toBe(2222);
		expect(hosts[0].privateKeyPath).toBe("~/.ssh/id_ed25519");

		expect(hosts[1].alias).toBe("aliyun-prod");
		expect(hosts[1].host).toBe("82.156.246.55");
		expect(hosts[1].username).toBe("root");
		expect(hosts[1].port).toBe(22);
	});

	it("忽略包含通配符的块", () => {
		const sample = `
Host *.internal
    User ubuntu

Host ??.example.com
    Port 22
`;
		const hosts = parseSshConfig(sample);
		expect(hosts).toHaveLength(0);
	});
});
