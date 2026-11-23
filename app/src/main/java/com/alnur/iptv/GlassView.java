package com.alnur.iptv;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.TextureView;
import android.widget.FrameLayout;

/**
 * Real frosted glass (like iOS .ultraThinMaterial): shows the BLURRED video that is behind it,
 * plus a light tint, a soft top highlight and a thin bright border.
 * The blurred frame comes from {@link Blur#frame} (a small copy of the video, refreshed while controls are visible).
 */
public class GlassView extends FrameLayout {
    float radius;           // px; < 0 = fully round (pill / circle)
    int tint = Color.argb(70, 18, 18, 24);
    final Paint bmpPaint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
    final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    final Path clip = new Path();
    final RectF box = new RectF();
    final int[] me = new int[2], tv = new int[2];
    final Rect src = new Rect(), dst = new Rect();
    Blur blur;

    public GlassView(Context c, Blur blur, float radiusPx) {
        super(c);
        this.blur = blur;
        this.radius = radiusPx;
        setWillNotDraw(false);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(Math.max(1f, c.getResources().getDisplayMetrics().density));
        stroke.setColor(Color.argb(80, 255, 255, 255));
        blur.views.add(this);
    }

    @Override
    protected void onSizeChanged(int w, int h, int ow, int oh) {
        super.onSizeChanged(w, h, ow, oh);
        float r = radius < 0 ? Math.min(w, h) / 2f : radius;
        box.set(0, 0, w, h);
        clip.reset();
        clip.addRoundRect(box, r, r, Path.Direction.CW);
        fill.setShader(new LinearGradient(0, 0, 0, h, Color.argb(46, 255, 255, 255), Color.argb(8, 255, 255, 255), Shader.TileMode.CLAMP));
    }

    @Override
    protected void dispatchDraw(Canvas c) {
        int w = getWidth(), h = getHeight();
        if (w == 0 || h == 0) { super.dispatchDraw(c); return; }
        int save = c.save();
        c.clipPath(clip);
        Bitmap f = blur.frame;
        TextureView t = blur.texture;
        boolean drew = false;
        if (f != null && t != null && t.getWidth() > 0 && t.getHeight() > 0) {
            getLocationOnScreen(me);
            t.getLocationOnScreen(tv);
            float sx = f.getWidth() / (float) t.getWidth(), sy = f.getHeight() / (float) t.getHeight();
            // part of this glass that lies over the video picture
            int l = Math.max(me[0], tv[0]), tp = Math.max(me[1], tv[1]);
            int r = Math.min(me[0] + w, tv[0] + t.getWidth()), b = Math.min(me[1] + h, tv[1] + t.getHeight());
            c.drawColor(Color.argb(255, 10, 10, 12));
            if (r > l && b > tp) {
                src.set(Math.round((l - tv[0]) * sx), Math.round((tp - tv[1]) * sy), Math.round((r - tv[0]) * sx), Math.round((b - tv[1]) * sy));
                if (src.width() < 1) src.right = src.left + 1;
                if (src.height() < 1) src.bottom = src.top + 1;
                dst.set(l - me[0], tp - me[1], r - me[0], b - me[1]);
                c.drawBitmap(f, src, dst, bmpPaint);
            }
            drew = true;
        }
        c.drawColor(drew ? tint : Color.argb(170, 30, 30, 38)); // no video copy yet: plain smoky glass
        c.drawRect(box, fill);                                      // soft top highlight
        c.restoreToCount(save);
        float r = radius < 0 ? Math.min(w, h) / 2f : radius;
        float half = stroke.getStrokeWidth() / 2f;
        c.drawRoundRect(half, half, w - half, h - half, r, r, stroke);
        super.dispatchDraw(c);
    }
}
