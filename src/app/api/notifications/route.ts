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
  const activeKeys = alerts.map((a) => a.id);

  await Promise.all(
    alerts.map((a) =>
      Notification.updateOne(
        { dedupeKey: a.id },
        {
          $set: {
            type: a.type,
            title: a.title,
            detail: a.detail,
            severity: a.severity,
            resolved: false,
          },
          $setOnInsert: { dedupeKey: a.id, read: false },
        },
        { upsert: true },
      ),
    ),
  );

  await Notification.updateMany(
    { dedupeKey: { $nin: activeKeys }, resolved: false },
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

    const items = await Notification.find({ resolved: false })
      .sort({ read: 1, createdAt: -1 })
      .limit(50);
    const unreadCount = await Notification.countDocuments({
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

    await connectDB();
    const body = (await req.json().catch(() => null)) ?? {};

    if (body.all) {
      await Notification.updateMany({ read: false }, { $set: { read: true } });
      return NextResponse.json({ ok: true });
    }

    const id = String(body.id || "");
    if (!id) {
      return NextResponse.json({ error: "id or all is required" }, { status: 400 });
    }
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid notification id" }, { status: 400 });
    }
    await Notification.updateOne({ _id: id }, { $set: { read: true } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update notification") },
      { status: 500 },
    );
  }
}
