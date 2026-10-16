import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { Notification } from "@/lib/models";
import { buildAlerts } from "@/lib/notifications/alerts";
import { toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import type { AppSession } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * Syncs the live alert conditions into Notification docs: new conditions are
 * inserted unread, conditions still active are left alone (read state
 * persists), and conditions no longer present are marked resolved so they
 * drop out of the bell without losing history.
 */
async function syncNotifications(session: AppSession) {
  const alerts = await buildAlerts(session);
  // What a user is shown depends on their role and branch, so each user
  // has their own documents — one user's sync or "mark all read" must never
  // touch (or reveal) another's.
  const keyOf = (alertId: string) => `${session.userId}:${alertId}`;
  const activeKeys = alerts.map((a) => keyOf(a.id));

  // One round trip for every alert (a large catalogue can have hundreds of
  // low-stock alerts), not one updateOne each.
  if (alerts.length > 0) {
    await Notification.bulkWrite(
      alerts.map((a) => ({
        updateOne: {
          filter: { dedupeKey: keyOf(a.id) },
          update: {
            $set: {
              type: a.type,
              title: a.title,
              detail: a.detail,
              severity: a.severity,
              resolved: false,
            },
            $setOnInsert: { dedupeKey: keyOf(a.id), userId: session.userId, read: false },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  await Notification.updateMany(
    { userId: session.userId, dedupeKey: { $nin: activeKeys }, resolved: false },
    { $set: { resolved: true } },
  );
}

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;
    const session = access as AppSession;

    await connectDB();
    await syncNotifications(session);

    const items = await Notification.find({ userId: session.userId, resolved: false })
      .sort({ read: 1, createdAt: -1 })
      .limit(50);
    const unreadCount = await Notification.countDocuments({
      userId: session.userId,
      resolved: false,
      read: false,
    });

    return NextResponse.json({ items: toJSONList(items), unreadCount });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load notifications") },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const session = access as AppSession;

    await connectDB();
    const body = (await req.json().catch(() => null)) ?? {};

    if (body.all) {
      await Notification.updateMany(
        { userId: session.userId, read: false },
        { $set: { read: true } },
      );
      return NextResponse.json({ ok: true });
    }

    const id = String(body.id || "");
    if (!id) {
      return NextResponse.json({ error: "id or all is required" }, { status: 400 });
    }
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid notification id" }, { status: 400 });
    }
    await Notification.updateOne({ _id: id, userId: session.userId }, { $set: { read: true } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update notification") },
      { status: 500 },
    );
  }
}
