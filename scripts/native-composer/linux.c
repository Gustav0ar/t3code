#define _GNU_SOURCE
#include <linux/input-event-codes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>

#include "virtual-keyboard-client.h"

static struct zwp_virtual_keyboard_manager_v1 *manager;
static struct wl_seat *seat;

static void fail(const char *message) {
  fprintf(stderr, "%s\n", message);
  exit(1);
}

static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
  (void)data;
  (void)version;
  if (strcmp(interface, "zwp_virtual_keyboard_manager_v1") == 0)
    manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
  if (strcmp(interface, "wl_seat") == 0 && !seat)
    seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
}

static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

static const struct wl_registry_listener registry_listener = {global, global_remove};

static uint32_t timestamp(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void wayland_key(struct wl_display *display, struct zwp_virtual_keyboard_v1 *keyboard,
                        struct xkb_state *state, uint32_t code, bool down) {
  zwp_virtual_keyboard_v1_key(keyboard, timestamp(), code, down);
  xkb_state_update_key(state, code + 8, down ? XKB_KEY_DOWN : XKB_KEY_UP);
  zwp_virtual_keyboard_v1_modifiers(
      keyboard, xkb_state_serialize_mods(state, XKB_STATE_MODS_DEPRESSED),
      xkb_state_serialize_mods(state, XKB_STATE_MODS_LATCHED),
      xkb_state_serialize_mods(state, XKB_STATE_MODS_LOCKED),
      xkb_state_serialize_layout(state, XKB_STATE_LAYOUT_EFFECTIVE));
  if (wl_display_roundtrip(display) < 0) fail("Wayland key delivery failed");
  usleep(30000);
}

int main(int argc, char **argv) {
  if (argc != 4) fail("Usage: linux-input <x11|wayland> <us|intl> <keys>");
  bool wayland = strcmp(argv[1], "wayland") == 0;
  if (!wayland && strcmp(argv[1], "x11") != 0) fail("Unknown display backend");
  bool intl = strcmp(argv[2], "intl") == 0;
  if (!intl && strcmp(argv[2], "us") != 0) fail("Unknown layout");
  struct wl_display *display = NULL;
  struct zwp_virtual_keyboard_v1 *keyboard = NULL;
  struct xkb_context *context = NULL;
  struct xkb_keymap *keymap = NULL;
  struct xkb_state *state = NULL;
  Display *xdisplay = NULL;
  if (wayland) {
    display = wl_display_connect(NULL);
    if (!display) fail("Cannot connect to isolated Wayland compositor");
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !manager || !seat)
      fail("Compositor lacks virtual-keyboard protocol or seat");
    context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    struct xkb_rule_names names = {.layout = "us", .variant = intl ? "intl" : ""};
    keymap = xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap) fail("Cannot build native XKB keymap");
    state = xkb_state_new(keymap);
    if (!state) fail("Cannot create keyboard state");
    char *mapping = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
    if (!mapping) fail("Cannot serialize keyboard mapping");
    size_t size = strlen(mapping) + 1;
    int fd = memfd_create("native-composer-keymap", MFD_CLOEXEC);
    if (fd < 0 || write(fd, mapping, size) != (ssize_t)size) fail("Cannot share keyboard mapping");
    keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager, seat);
    zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, size);
    if (wl_display_roundtrip(display) < 0) fail("Compositor rejected keyboard mapping");
    close(fd);
    free(mapping);
    char symbol[64];
    xkb_keysym_get_name(xkb_state_key_get_one_sym(state, KEY_APOSTROPHE + 8), symbol, sizeof(symbol));
    printf("backend=wayland layout=us variant=%s quote=%s\n", intl ? "intl" : "", symbol);
    // Confirm the new keymap reached Chromium with a native modifier release
    // before sending the requested sequence.
    wayland_key(display, keyboard, state, KEY_LEFTSHIFT, true);
    wayland_key(display, keyboard, state, KEY_LEFTSHIFT, false);
    if (getchar() != '\n') fail("Controller did not acknowledge the native keymap");
  } else {
    xdisplay = XOpenDisplay(NULL);
    if (!xdisplay) fail("Cannot connect to isolated X11 display");
    Window focused;
    int revert;
    XGetInputFocus(xdisplay, &focused, &revert);
    printf("backend=x11 display=%s focus=%lu\n", DisplayString(xdisplay), focused);
  }
  char *sequence = strdup(argv[3]);
  for (char *token = strtok(sequence, ","); token; token = strtok(NULL, ",")) {
    if (strcmp(token, "pause") == 0) {
      usleep(350000);
      continue;
    }
    bool shift = strcmp(token, "double") == 0;
    uint32_t code;
    if (strcmp(token, "quote") == 0 || shift) code = KEY_APOSTROPHE;
    else if (strcmp(token, "space") == 0) code = KEY_SPACE;
    else if (strcmp(token, "e") == 0) code = KEY_E;
    else if (strcmp(token, "escape") == 0) code = KEY_ESC;
    else fail("Unknown physical key");
    uint32_t keys[] = {KEY_LEFTSHIFT, code, code, KEY_LEFTSHIFT};
    bool pressed[] = {true, true, false, false};
    for (int i = shift ? 0 : 1; i < (shift ? 4 : 3); i++) {
      if (wayland) wayland_key(display, keyboard, state, keys[i], pressed[i]);
      else {
        if (!XTestFakeKeyEvent(xdisplay, keys[i] + 8, pressed[i], 0)) fail("XTest key injection failed");
        XSync(xdisplay, False);
        usleep(30000);
      }
    }
  }
  free(sequence);
  if (wayland) {
    zwp_virtual_keyboard_v1_destroy(keyboard);
    wl_display_roundtrip(display);
    wl_display_disconnect(display);
    xkb_state_unref(state);
    xkb_keymap_unref(keymap);
    xkb_context_unref(context);
  } else XCloseDisplay(xdisplay);
  return 0;
}
