package com.alnur.iptv;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.TextureView;
import android.widget.FrameLayout;

/**
 * Frosted "liquid" glass like iOS: the video behind it, blurred, a bit more colourful and brighter,
 * under a light tint, a soft top sheen and a bright rim (strong at the top, fading to the bottom).
 * Outside the picture (black bars) the edge of the video is stretched, so the glass never looks like a black hole.
 */
public class GlassView extends FrameLayout {
    float radius;           // px; < 0 = fully round (pill / circle)
    int tint = Color.argb(50, 12, 12, 18);
    final Paint bmpPaint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
    final Paint sheen = new Paint(Paint.ANTI_ALIAS_FLAG);
    final Paint rim = new Paint(Paint.ANTI_ALIAS_FLAG);
    final Path clip = new Path();
    final RectF box = new RectF();
    final int[] me = new int[2], tv = new int[2];
    final Matrix m = new Matrix();
    Bitmap shaderFor;
    BitmapShader shader;
    Blur blur;

    public GlassView(Context c, Blur blur, float radiusPx) {
        super(c);
        this.blur = blur;
        this.radius = radiusPx;
        setWillNotDraw(false);
        ColorMatrix cm = new ColorMatrix();
        cm.setSaturation(1.7f);                         // iOS materials make the colours behind them livelier
        ColorMatrix lift = new ColorMatrix(new float[]{ // and a little brighter
                1.08f, 0, 0, 0, 10,
                0, 1.08f, 0, 0, 10,
                0, 0, 1.08f, 0, 10,
                0, 0, 0, 1, 0});
        cm.postConcat(lift);
        bmpPaint.setColorFilter(new ColorMatrixColorFilter(cm));
        rim.setStyle(Paint.Style.STROKE);
        rim.setStrokeWidth(Math.max(1.5f, 1.3f * c.getResources().getDisplayMetrics().density));
        blur.views.add(this);
    }

    float r() { return radius < 0 ? Math.min(getWidth(), getHeight()) / 2f : radius; }

    @Override
    protected void onSizeChanged(int w, int h, int ow, int oh) {
        super.onSizeChanged(w, h, ow, oh);
        float r = r();
        box.set(0, 0, w, h);
        clip.reset();
        clip.addRoundRect(box, r, r, Path.Direction.CW);
        sheen.setShader(new LinearGradient(0, 0, 0, h,
                new int[]{Color.argb(60, 255, 255, 255), Color.argb(14, 255, 255, 255), Color.argb(0, 255, 255, 255), Color.argb(22, 255, 255, 255)},
                new float[]{0f, 0.45f, 0.8f, 1f}, Shader.TileMode.CLAMP));
        rim.setShader(new LinearGradient(0, 0, 0, h,
                new int[]{Color.argb(170, 255, 255, 255), Color.argb(45, 255, 255, 255), Color.argb(90, 255, 255, 255)},
                new float[]{0f, 0.6f, 1f}, Shader.TileMode.CLAMP));
    }

    @Override
    protected void dispatchDraw(Canvas c) {
        int w = getWidth(), h = getHeight();
        if (w == 0 || h == 0) { super.dispatchDraw(c); return; }
        int save = c.save();
        c.clipPath(clip);
        Bitmap f = blur.frame;
        TextureView t = blur.texture;
        if (f != null && t != null && t.getWidth() > 0 && t.getHeight() > 0) {
            if (shaderFor != f) { shader = new BitmapShader(f, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP); shaderFor = f; bmpPaint.setShader(shader); }
            getLocationOnScreen(me);
            t.getLocationOnScreen(tv);
            m.setScale(t.getWidth() / (float) f.getWidth(), t.getHeight() / (float) f.getHeight());
            m.postTranslate(tv[0] - me[0], tv[1] - me[1]);
            shader.setLocalMatrix(m);
            c.drawRect(box, bmpPaint);
            c.drawColor(tint);
        } else {
            c.drawColor(Color.argb(175, 34, 34, 42)); // no picture yet: smoky glass
        }
        c.drawRect(box, sheen);
        c.restoreToCount(save);
        float r = r(), half = rim.getStrokeWidth() / 2f;
        c.drawRoundRect(half, half, w - half, h - half, r - half, r - half, rim);
        super.dispatchDraw(c);
    }
}
