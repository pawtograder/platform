/**
 * NotificationManager - Singleton class for managing browser notifications
 *
 * Handles:
 * - Title flashing with original title restoration
 * - Audio playback with volume control
 * - Web Notifications API with permission handling
 * - Favicon badge rendering with canvas
 * - Visibility state detection
 * - User preference management via localStorage
 */

const STORAGE_KEY = "pawtograder_chat_notification_prefs";
const DISMISS_KEY = "pawtograder_notification_warning_dismissed";

export interface ChatNotificationPreferences {
  soundEnabled: boolean;
  browserEnabled: boolean;
  titleFlashEnabled: boolean;
  faviconBadgeEnabled: boolean;
  volume: number;
}

export interface NotifyOptions {
  title: string;
  body: string;
  tag?: string;
  icon?: string;
  onClick?: () => void;
}

const DEFAULT_PREFERENCES: ChatNotificationPreferences = {
  soundEnabled: true,
  browserEnabled: true,
  titleFlashEnabled: true,
  faviconBadgeEnabled: true,
  volume: 0.5
};

class NotificationManager {
  private static instance: NotificationManager | null = null;

  private originalTitle: string = "";
  private originalFavicon: string = "";
  private flashInterval: ReturnType<typeof setInterval> | null = null;
  private audio: HTMLAudioElement | null = null;
  private unreadCount: number = 0;
  private isFlashing: boolean = false;

  private constructor() {
    // Initialize only in browser environment
    if (typeof window !== "undefined") {
      this.originalTitle = document.title;
      this.originalFavicon = this.getCurrentFavicon();
      this.setupVisibilityListener();
    }
  }

  /**
   * Get the singleton instance of NotificationManager
   */
  public static getInstance(): NotificationManager {
    if (!NotificationManager.instance) {
      NotificationManager.instance = new NotificationManager();
    }
    return NotificationManager.instance;
  }

  /**
   * Get the current favicon URL
   */
  private getCurrentFavicon(): string {
    if (typeof document === "undefined") return "";
    const link = document.querySelector("link[rel*='icon']") as HTMLLinkElement;
    return link?.href || "/favicon.ico";
  }

  /**
   * Set up listeners to clear notifications when user returns to the page
   * Handles both tab visibility changes AND window focus changes
   */
  private setupVisibilityListener(): void {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    // Clear notifications when tab becomes visible
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        this.clearNotifications();
      }
    });

    // Clear notifications when window gains focus (user switched back from another app)
    window.addEventListener("focus", () => {
      this.clearNotifications();
    });
  }

  /**
   * Check if user is actively viewing the page
   * Returns true if page is visible AND has focus (no other app in front)
   */
  private isUserActivelyViewing(): boolean {
    if (typeof document === "undefined") return true;
    // User is actively viewing if the page is visible AND the window has focus
    return document.visibilityState === "visible" && document.hasFocus();
  }

  /**
   * Get user's notification preferences from localStorage
   */
  public getPreferences(): ChatNotificationPreferences {
    if (typeof localStorage === "undefined") {
      return DEFAULT_PREFERENCES;
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...DEFAULT_PREFERENCES, ...parsed };
      }
    } catch (error) {
      console.error("Failed to parse notification preferences:", error);
    }

    return DEFAULT_PREFERENCES;
  }

  /**
   * Save user's notification preferences to localStorage
   */
  public setPreferences(preferences: Partial<ChatNotificationPreferences>): void {
    if (typeof localStorage === "undefined") return;

    try {
      const current = this.getPreferences();
      const updated = { ...current, ...preferences };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (error) {
      console.error("Failed to save notification preferences:", error);
    }
  }

  /**
   * Get the current browser notification permission state
   */
  public getPermissionState(): NotificationPermission | "unsupported" {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return "unsupported";
    }
    return Notification.permission;
  }

  /**
   * Request browser notification permission
   * @returns Promise resolving to the new permission state
   */
  public async requestPermission(): Promise<NotificationPermission | "unsupported"> {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return "unsupported";
    }

    try {
      const permission = await Notification.requestPermission();
      return permission;
    } catch (error) {
      console.error("Failed to request notification permission:", error);
      return "denied";
    }
  }

  /**
   * Check if the warning has been dismissed for this session
   */
  public isWarningDismissed(): boolean {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(DISMISS_KEY) === "true";
  }

  /**
   * Dismiss the warning for this session
   */
  public dismissWarning(): void {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(DISMISS_KEY, "true");
  }

  /**
   * Clear the warning dismissal (for testing or settings reset)
   */
  public clearWarningDismissal(): void {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(DISMISS_KEY);
  }

  /**
   * Trigger notification(s) based on user preferences
   */
  public notify(options: NotifyOptions): void {
    if (typeof window === "undefined") return;

    // Only notify if user is not actively viewing the page
    // Check both visibility state AND focus - user might have another app in front
    if (this.isUserActivelyViewing()) {
      return;
    }

    const preferences = this.getPreferences();

    // Increment unread count
    this.unreadCount++;

    // Title flashing
    if (preferences.titleFlashEnabled) {
      this.startTitleFlash(options.title);
    }

    // Audio notification
    if (preferences.soundEnabled) {
      this.playSound(preferences.volume);
    }

    // Browser notification
    if (preferences.browserEnabled && this.getPermissionState() === "granted") {
      this.showBrowserNotification(options);
    }

    // Favicon badge
    if (preferences.faviconBadgeEnabled) {
      this.updateFaviconBadge(this.unreadCount);
    }
  }

  /**
   * Start flashing the document title
   */
  private startTitleFlash(message: string): void {
    if (this.isFlashing) return;

    this.isFlashing = true;
    this.originalTitle = document.title;
    let isOriginal = true;

    this.flashInterval = setInterval(() => {
      document.title = isOriginal ? `🔔 ${message}` : this.originalTitle;
      isOriginal = !isOriginal;
    }, 1000);
  }

  /**
   * Stop flashing the document title
   */
  private stopTitleFlash(): void {
    if (this.flashInterval) {
      clearInterval(this.flashInterval);
      this.flashInterval = null;
    }
    this.isFlashing = false;
    if (typeof document !== "undefined" && this.originalTitle) {
      document.title = this.originalTitle;
    }
  }

  /**
   * Play notification sound using Web Audio API
   * Creates a pleasant two-tone chime programmatically
   */
  private playSound(volume: number): void {
    try {
      // Use Web Audio API for reliable cross-browser sound generation
      const AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof window.AudioContext }).webkitAudioContext;
      if (!AudioContext) {
        console.debug("Web Audio API not supported");
        return;
      }

      const audioContext = new AudioContext();
      const normalizedVolume = Math.max(0, Math.min(1, volume));

      // Create a pleasant two-tone notification chime
      const playTone = (frequency: number, startTime: number, duration: number) => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, startTime);

        // Envelope: quick attack, sustain, gradual release
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(normalizedVolume * 0.3, startTime + 0.02);
        gainNode.gain.setValueAtTime(normalizedVolume * 0.3, startTime + duration - 0.1);
        gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

        oscillator.start(startTime);
        oscillator.stop(startTime + duration);
      };

      const now = audioContext.currentTime;
      // First tone: C5 (523 Hz)
      playTone(523, now, 0.15);
      // Second tone: E5 (659 Hz) - creates a pleasant major third
      playTone(659, now + 0.12, 0.2);

      // Close audio context after sounds finish
      setTimeout(() => {
        audioContext.close().catch(() => {});
      }, 500);
    } catch (error) {
      console.debug("Failed to play notification sound:", error);
    }
  }

  /**
   * Show a browser notification
   */
  private showBrowserNotification(options: NotifyOptions): void {
    try {
      const notification = new Notification(options.title, {
        body: options.body,
        icon: options.icon || "/Logo-Light.png",
        tag: options.tag || "chat-notification",
        requireInteraction: false
      });

      if (options.onClick) {
        notification.onclick = () => {
          window.focus();
          options.onClick?.();
          notification.close();
        };
      } else {
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      }

      // Auto-close after 5 seconds
      setTimeout(() => {
        notification.close();
      }, 5000);
    } catch (error) {
      console.error("Failed to show browser notification:", error);
    }
  }

  /**
   * Update the favicon with an unread count badge
   */
  private updateFaviconBadge(count: number): void {
    if (typeof document === "undefined") return;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d");

      if (!ctx) return;

      // Load original favicon
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        // Draw original favicon
        ctx.drawImage(img, 0, 0, 32, 32);

        if (count > 0) {
          // Draw red badge circle
          ctx.fillStyle = "#FF3B30";
          ctx.beginPath();
          ctx.arc(24, 8, 10, 0, 2 * Math.PI);
          ctx.fill();

          // Draw white border
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 2;
          ctx.stroke();

          // Draw count
          ctx.fillStyle = "#FFFFFF";
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(count > 9 ? "9+" : String(count), 24, 8);
        }

        // Update favicon
        const link = (document.querySelector("link[rel*='icon']") as HTMLLinkElement) || document.createElement("link");
        link.rel = "icon";
        link.href = canvas.toDataURL();
        if (!document.querySelector("link[rel*='icon']")) {
          document.head.appendChild(link);
        }
      };
      img.onerror = () => {
        // If original favicon fails to load, just draw the badge
        if (count > 0) {
          ctx.fillStyle = "#4A90D9";
          ctx.fillRect(0, 0, 32, 32);
          ctx.fillStyle = "#FF3B30";
          ctx.beginPath();
          ctx.arc(24, 8, 10, 0, 2 * Math.PI);
          ctx.fill();
          ctx.fillStyle = "#FFFFFF";
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(count > 9 ? "9+" : String(count), 24, 8);

          const link =
            (document.querySelector("link[rel*='icon']") as HTMLLinkElement) || document.createElement("link");
          link.rel = "icon";
          link.href = canvas.toDataURL();
          if (!document.querySelector("link[rel*='icon']")) {
            document.head.appendChild(link);
          }
        }
      };
      img.src = this.originalFavicon;
    } catch (error) {
      console.error("Failed to update favicon badge:", error);
    }
  }

  /**
   * Restore the original favicon
   */
  private restoreFavicon(): void {
    if (typeof document === "undefined") return;

    const link = document.querySelector("link[rel*='icon']") as HTMLLinkElement;
    if (link && this.originalFavicon) {
      link.href = this.originalFavicon;
    }
  }

  /**
   * Clear all notifications (title flash, favicon badge)
   * Called when tab becomes visible
   */
  public clearNotifications(): void {
    this.stopTitleFlash();
    this.unreadCount = 0;
    this.restoreFavicon();
  }

  /**
   * Test notification - trigger all enabled notifications for testing
   */
  public testNotification(): void {
    const preferences = this.getPreferences();

    // Force notification even if tab is visible
    if (preferences.soundEnabled) {
      this.playSound(preferences.volume);
    }

    if (preferences.browserEnabled && this.getPermissionState() === "granted") {
      this.showBrowserNotification({
        title: "Test Notification",
        body: "This is a test notification from Pawtograder.",
        tag: "test-notification"
      });
    }

    if (preferences.titleFlashEnabled) {
      // Flash briefly for test
      const originalTitle = document.title;
      document.title = "🔔 Test Notification";
      setTimeout(() => {
        document.title = originalTitle;
      }, 2000);
    }

    if (preferences.faviconBadgeEnabled) {
      // Show badge briefly for test
      this.updateFaviconBadge(1);
      setTimeout(() => {
        this.restoreFavicon();
      }, 3000);
    }
  }

  /**
   * Get the current unread count
   */
  public getUnreadCount(): number {
    return this.unreadCount;
  }

  /**
   * Check if page is currently visible AND focused
   * Returns true only if the user is actively viewing this page
   */
  public isPageVisible(): boolean {
    if (typeof document === "undefined") return true;
    // Page is considered visible only if it's not hidden AND has focus
    return document.visibilityState === "visible" && document.hasFocus();
  }
}

// Export singleton getter
export const getNotificationManager = (): NotificationManager => {
  return NotificationManager.getInstance();
};

export default NotificationManager;
