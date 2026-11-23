package com.alnur.iptv;

import android.graphics.Bitmap;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;

import java.util.ArrayList;

/** Keeps a small, blurred copy of the current video frame for the {@link GlassView}s. */
public class Blur {
    static final int SCALE = 8;    // copy at 1/8 size (it is blurred anyway – cheap)
    static final int RADIUS = 4;   // box-blur radius at that size, 3 passes ≈ gaussian

    final ArrayList<GlassView> views = new ArrayList<>();
    TextureView texture;
    volatile Bitmap frame;          // shown by the glass views
    Bitmap work;                    // filled from the video, then blurred, then swapped with frame
    int[] px, tmp;

    static TextureView find(View v) {
        if (v instanceof TextureView) return (TextureView) v;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) { TextureView t = find(g.getChildAt(i)); if (t != null) return t; }
        }
        return null;
    }

    /** grab + blur the current frame and redraw visible glass. Call on the UI thread ~15×/s while glass is visible. */
    void refresh(View videoRoot) {
        if (texture == null || !texture.isAttachedToWindow()) texture = find(videoRoot);
        TextureView t = texture;
        if (t == null || !t.isAvailable() || t.getWidth() < SCALE || t.getHeight() < SCALE) return;
        int w = Math.max(8, t.getWidth() / SCALE), h = Math.max(8, t.getHeight() / SCALE);
        try {
            if (work == null || work.getWidth() != w || work.getHeight() != h) {
                work = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                px = new int[w * h]; tmp = new int[w * h];
            }
            Bitmap b = t.getBitmap(work);
            if (b == null) return;
            b.getPixels(px, 0, w, 0, 0, w, h);
            for (int k = 0; k < 3; k++) { boxH(px, tmp, w, h, RADIUS); boxV(tmp, px, w, h, RADIUS); }
            b.setPixels(px, 0, w, 0, 0, w, h);
            Bitmap old = frame;
            frame = b;
            work = (old != null && old.getWidth() == w && old.getHeight() == h) ? old : null;
            for (GlassView g : views) if (g.isShown()) g.invalidate();
        } catch (Exception ignored) { }
    }

    static void boxH(int[] in, int[] out, int w, int h, int r) {
        int div = r * 2 + 1;
        for (int y = 0; y < h; y++) {
            int row = y * w, a = 0, rr = 0, gg = 0, bb = 0;
            for (int i = -r; i <= r; i++) { int p = in[row + Math.min(w - 1, Math.max(0, i))]; rr += (p >> 16) & 255; gg += (p >> 8) & 255; bb += p & 255; }
            for (int x = 0; x < w; x++) {
                out[row + x] = 0xFF000000 | ((rr / div) << 16) | ((gg / div) << 8) | (bb / div);
                int pa = in[row + Math.min(w - 1, x + r + 1)], pr = in[row + Math.max(0, x - r)];
                rr += ((pa >> 16) & 255) - ((pr >> 16) & 255);
                gg += ((pa >> 8) & 255) - ((pr >> 8) & 255);
                bb += (pa & 255) - (pr & 255);
            }
        }
    }

    static void boxV(int[] in, int[] out, int w, int h, int r) {
        int div = r * 2 + 1;
        for (int x = 0; x < w; x++) {
            int rr = 0, gg = 0, bb = 0;
            for (int i = -r; i <= r; i++) { int p = in[Math.min(h - 1, Math.max(0, i)) * w + x]; rr += (p >> 16) & 255; gg += (p >> 8) & 255; bb += p & 255; }
            for (int y = 0; y < h; y++) {
                out[y * w + x] = 0xFF000000 | ((rr / div) << 16) | ((gg / div) << 8) | (bb / div);
                int pa = in[Math.min(h - 1, y + r + 1) * w + x], pr = in[Math.max(0, y - r) * w + x];
                rr += ((pa >> 16) & 255) - ((pr >> 16) & 255);
                gg += ((pa >> 8) & 255) - ((pr >> 8) & 255);
                bb += (pa & 255) - (pr & 255);
            }
        }
    }
}
