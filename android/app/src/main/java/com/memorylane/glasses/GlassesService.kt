package com.memorylane.glasses

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log

/**
 * Keeps Memory Lane alive while the glasses are connected and the phone is in a pocket with
 * its screen off. Without it Android may suspend the app a few minutes after the screen
 * locks, and the wearer would get silence.
 *
 * The service does no work of its own. It holds the ongoing notification that tells Android,
 * and whoever picks up the phone, that the glasses session is running.
 */
class GlassesService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Glasses connection", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while Memory Lane is connected to the glasses."
        },
    )
    val open =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
    val notification =
        Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Memory Lane is connected to the glasses")
            .setContentText("Tap to open, pause or disconnect.")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    try {
      startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } catch (e: Exception) {
      // Android refuses this without the Bluetooth permission. The session still works while
      // the app is on screen; it just is not protected in the background.
      Log.w("MemoryLane", "Could not keep running in the background: ${e.message}")
      stopSelf()
    }
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL = "glasses"

    fun start(context: Context) {
      runCatching { context.startForegroundService(Intent(context, GlassesService::class.java)) }
          .onFailure { Log.w("MemoryLane", "Background service did not start: ${it.message}") }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, GlassesService::class.java))
    }
  }
}
