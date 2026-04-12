import "@/lib/env";
import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import STS from "qcloud-cos-sts";
import { db, roomMembers } from "@agent-platform/db";
import { and, eq } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("web");

export const dynamic = "force-dynamic";

function getCredentialAsync(opts: Parameters<typeof STS.getCredential>[0]) {
  return new Promise<any>((resolve, reject) => {
    STS.getCredential(opts, (err: any, cred: any) => {
      if (err) reject(err);
      else resolve(cred);
    });
  });
}

export async function POST(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId } = await req.json();
  if (!roomId) return Response.json({ error: "Missing roomId" }, { status: 400 });

  // Verify membership
  const [member] = await db
    .select()
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.memberId, user.id),
        eq(roomMembers.memberType, "user")
      )
    );
  if (!member) return Response.json({ error: "Forbidden" }, { status: 403 });

  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  const bucket = process.env.TENCENT_COS_BUCKET;
  const region = process.env.TENCENT_COS_REGION;
  if (!secretId || !secretKey || !bucket || !region) {
    return Response.json({ error: "COS not configured" }, { status: 500 });
  }

  // Bucket format: name-appId
  const dash = bucket.lastIndexOf("-");
  const appId = dash > 0 ? bucket.slice(dash + 1) : "";
  if (!appId) {
    return Response.json({ error: "Invalid COS bucket name" }, { status: 500 });
  }

  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const key = `rooms/${roomId}/${user.id}/${yyyymm}/${randomUUID()}.jpg`;

  try {
    const cred = await getCredentialAsync({
      secretId,
      secretKey,
      durationSeconds: 600,
      policy: {
        version: "2.0",
        statement: [
          {
            action: ["name/cos:PutObject"],
            effect: "allow",
            resource: [`qcs::cos:${region}:uid/${appId}:${bucket}/${key}`],
          },
        ],
      },
    });

    const publicUrl = `https://${bucket}.cos.${region}.myqcloud.com/${key}`;

    return Response.json({
      credentials: cred.credentials,
      startTime: cred.startTime,
      expiredTime: cred.expiredTime,
      bucket,
      region,
      key,
      publicUrl,
    });
  } catch (err: any) {
    log.error(
      {
        err: err?.message,
        responseData: err?.response?.data,
        responseBody: err?.response?.body,
        stack: err?.stack,
        userId: user.id,
        roomId,
        bucket,
        region,
        appId,
        key,
      },
      "sts.sign-failed"
    );
    return Response.json({ error: "Failed to sign credentials" }, { status: 500 });
  }
}
