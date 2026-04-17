import { SignJWT, jwtVerify } from "jose";

const TOKEN_TTL_SECONDS = 600; // 10 minutes

function getSecret(): Uint8Array {
  const raw = process.env.INTERNAL_JWT_SECRET;
  if (!raw) {
    throw new Error("INTERNAL_JWT_SECRET is not set");
  }
  return new TextEncoder().encode(raw);
}

export interface ToolContext {
  userId: string;
  roomId: string;
}

/** Sign a short-lived token binding the coming tool callbacks to this user+room */
export async function signToolToken(ctx: ToolContext): Promise<string> {
  return new SignJWT({ roomId: ctx.roomId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(ctx.userId)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

/** Verify + decode a tool callback token. Throws if invalid/expired. */
export async function verifyToolToken(token: string): Promise<ToolContext> {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: ["HS256"],
  });
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("token missing sub");
  }
  if (typeof payload.roomId !== "string" || !payload.roomId) {
    throw new Error("token missing roomId");
  }
  return { userId: payload.sub, roomId: payload.roomId };
}
