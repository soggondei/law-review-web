import { NextRequest, NextResponse } from "next/server";

async function makeToken(pw: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(pw + "|law-review-auth"),
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(req: NextRequest) {
  const { password } = await req.json().catch(() => ({ password: "" }));

  if (!password || password !== process.env.SITE_PASSWORD) {
    return NextResponse.json({ error: "잘못된 암호입니다" }, { status: 401 });
  }

  const token = await makeToken(password);
  const res   = NextResponse.json({ ok: true });
  res.cookies.set("auth_token", token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   60 * 60 * 24 * 30, // 30일
  });
  return res;
}
