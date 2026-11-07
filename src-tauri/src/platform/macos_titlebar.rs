use std::ptr::NonNull;
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use dispatch2::MainThreadBound;
use objc2::{rc::Retained, runtime::ProtocolObject, MainThreadMarker};
use objc2_app_kit::{
    NSView, NSWindow, NSWindowButton, NSWindowDidUpdateNotification, NSWindowStyleMask,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
use tauri::{WebviewWindow, WindowEvent};

// Matches the macOS h-11 titlebar row in AppHeader, in logical points.
const TITLEBAR_CENTER_Y: f64 = 22.0;

pub(crate) fn watch_main_titlebar(window: &WebviewWindow) {
    let observer = Arc::new(Mutex::new(None));
    let slot = observer.clone();
    let _ = window.with_webview(move |webview| {
        let Some(main_thread) = MainThreadMarker::new() else {
            return;
        };
        // Tauri keeps the native window alive and runs this on the main thread.
        let window = unsafe { &*webview.ns_window().cast::<NSWindow>() };
        let on_update = RcBlock::new(|notification: NonNull<NSNotification>| {
            if MainThreadMarker::new().is_none() {
                return;
            }
            // The notification is borrowed only for this synchronous callback.
            let notification = unsafe { notification.as_ref() };
            let Some(object) = notification.object() else {
                return;
            };
            let Ok(window) = object.downcast::<NSWindow>() else {
                return;
            };
            if let Some(view) = window.contentView() {
                align_controls(&window, &view);
            }
        });
        // AppKit posts this after native window updates, including titlebar
        // relayouts that do not emit a Tauri resize or focus event.
        let token = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidUpdateNotification),
                Some(window),
                None,
                &on_update,
            )
        };
        *slot.lock().unwrap_or_else(|error| error.into_inner()) =
            Some(MainThreadBound::new(TitlebarObserver(token), main_thread));
        if let Some(view) = window.contentView() {
            align_controls(window, &view);
        }
    });
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            observer
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
        }
    });
}

struct TitlebarObserver(Retained<ProtocolObject<dyn NSObjectProtocol>>);

impl Drop for TitlebarObserver {
    fn drop(&mut self) {
        // MainThreadBound removes this live registration on the main thread.
        unsafe { NSNotificationCenter::defaultCenter().removeObserver((*self.0).as_ref()) };
    }
}

fn align_controls(window: &NSWindow, view: &NSView) {
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let bounds = view.bounds();
    if bounds.size.height < TITLEBAR_CENTER_Y * 2.0 {
        return;
    }
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let Some(button) = window.standardWindowButton(kind) else {
            continue;
        };
        // The standard button remains attached to this live window.
        let Some(parent) = (unsafe { button.superview() }) else {
            continue;
        };
        let rect = button.convertRect_toView(button.bounds(), Some(view));
        let center = rect.origin.y + rect.size.height / 2.0;
        let from_top = if view.isFlipped() {
            center - bounds.origin.y
        } else {
            bounds.origin.y + bounds.size.height - center
        };
        let delta = TITLEBAR_CENTER_Y - from_top;
        if !delta.is_finite() || delta.abs() < 0.25 {
            continue;
        }
        // Adjust the button itself: Wry resizes its titlebar container on
        // redraw without accounting for AppKit's native vertical offset.
        let mut origin = button.frame().origin;
        origin.y += if parent.isFlipped() { delta } else { -delta };
        button.setFrameOrigin(origin);
    }
}
