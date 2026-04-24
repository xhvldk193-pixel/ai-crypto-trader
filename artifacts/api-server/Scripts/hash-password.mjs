#!/usr/bin/env node
// scripts/hash-password.mjs
//
// 사용법: node scripts/hash-password.mjs <비밀번호>
// 출력을 OWNER_PASSWORD_HASH 환경변수에 넣으면 평문 저장이 사라짐.
//
// 형식: scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>

import crypto from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash-password.mjs <password>");
  process.exit(1);
}
if (password.length < 8) {
  console.error("⚠️  비밀번호가 너무 짧습니다. 최소 12자 이상을 권장합니다.");
}

const N = 16384; // CPU/메모리 비용 (2^14) — 일반 서버에서 100ms 내외
const r = 8;
const p = 1;
const keyLen = 64;

const salt = crypto.randomBytes(32);
const hash = crypto.scryptSync(password, salt, keyLen, { N, r, p, maxmem: 128 * N * r * 2 });

const serialized = `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${hash.toString("hex")}`;
console.log(serialized);
