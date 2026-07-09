import { Expo } from 'expo-server-sdk';
import { UserOnboarding } from '../models/UserOnboarding';

const expo = new Expo();

export async function sendChallengeNotification(
  userId: string,
  targetApp: string = 'the app',
  isTest: boolean = false
): Promise<void> {
  const user = await UserOnboarding.findOne({ uid: userId });

  if (!user?.pushToken) {
    console.warn(`⚠️ [Push]: No push token for user: ${userId}`);
    return;
  }

  if (!Expo.isExpoPushToken(user.pushToken)) {
    console.error(`❌ [Push]: Invalid push token for user ${userId}: ${user.pushToken}`);
    return;
  }

  const message = isTest
    ? {
        to: user.pushToken,
        title: 'IRONMIND TEST NOTIFICATION',
        body: 'This is a test — real challenges will look just like this.',
        sound: 'default' as const,
        data: { type: 'test' },
      }
    : {
        to: user.pushToken,
        title: 'IRONMIND CHALLENGE',
        body: `You opened ${targetApp}. Exit in under 10 seconds.`,
        sound: 'default' as const,
        data: { type: 'challenge' },
      };

  try {
    const [ticket] = await expo.sendPushNotificationsAsync([message]);

    if (ticket.status === 'error') {
      console.error(`❌ [Push]: Send rejected for user ${userId}:`, ticket.message, ticket.details);
      return;
    }

    console.log(`🔔 [Push]: Ticket accepted for user ${userId}, receiptId: ${ticket.id}`);

    // A successful ticket only means Expo accepted the request — the actual FCM/APNs
    // delivery result only shows up in the receipt a few seconds later. Missing FCM
    // credentials in EAS (eas credentials) surface here, not on the initial ticket.
    if (ticket.id) {
      setTimeout(() => checkReceipt(ticket.id!, userId), 15_000);
    }
  } catch (error) {
    console.error('❌ [Push]: Error sending notification:', error);
  }
}

async function checkReceipt(receiptId: string, userId: string): Promise<void> {
  try {
    const receipts = await expo.getPushNotificationReceiptsAsync([receiptId]);
    const receipt = receipts[receiptId];
    if (!receipt) {
      console.warn(`⚠️ [Push]: No receipt yet for user ${userId} (receiptId ${receiptId})`);
      return;
    }
    if (receipt.status === 'error') {
      console.error(`❌ [Push]: Delivery failed for user ${userId}:`, receipt.message, receipt.details);
    } else {
      console.log(`✅ [Push]: Delivered to device for user ${userId}`);
    }
  } catch (error) {
    console.error('❌ [Push]: Error checking receipt:', error);
  }
}
