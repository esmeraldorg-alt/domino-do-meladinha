package br.com.meladinha.domino;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/** Casca do Dominó do Meladinha: abre o jogo do servidor em tela cheia, na horizontal. O jogo se atualiza sozinho pelo servidor. */
public class MainActivity extends Activity {
    private static final String URL = "https://domino-do-meladinha.onrender.com/";
    private static final int ROXO = Color.parseColor("#150d3a");

    private WebView web;
    private TextView aviso;
    private boolean erro = false;

    @Override
    protected void onCreate(Bundle estado) {
        super.onCreate(estado);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout raiz = new FrameLayout(this);
        raiz.setBackgroundColor(ROXO);

        web = new WebView(this);
        web.setBackgroundColor(ROXO);
        raiz.addView(web, new FrameLayout.LayoutParams(-1, -1));

        aviso = new TextView(this);
        aviso.setText("Acordando o servidor...\nA primeira abertura do dia pode levar até 1 minuto.");
        aviso.setTextColor(Color.WHITE);
        aviso.setTextSize(18);
        aviso.setGravity(Gravity.CENTER);
        aviso.setBackgroundColor(ROXO);
        aviso.setPadding(48, 48, 48, 48);
        raiz.addView(aviso, new FrameLayout.LayoutParams(-1, -1));
        setContentView(raiz);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                       // o login e o apelido ficam guardados no aparelho
        s.setMediaPlaybackRequiresUserGesture(false);       // bipes e batidas da mesa
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String u, android.graphics.Bitmap b) {
                erro = false;
            }

            @Override
            public void onPageFinished(WebView v, String u) {
                if (!erro) aviso.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) {
                    erro = true;
                    aviso.setText("Sem conexão com o servidor.\nToque na tela para tentar de novo.");
                    aviso.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String host = u.getHost();
                if (host != null && host.endsWith("onrender.com")) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));   // links de fora abrem no navegador
                return true;
            }
        });
        aviso.setOnClickListener(v -> {
            aviso.setText("Conectando...");
            web.loadUrl(URL);
        });

        if (estado != null) web.restoreState(estado);
        else web.loadUrl(URL);
        imersivo();
    }

    private void imersivo() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean foco) {
        super.onWindowFocusChanged(foco);
        if (foco) imersivo();
    }

    @Override
    protected void onSaveInstanceState(Bundle saida) {
        super.onSaveInstanceState(saida);
        web.saveState(saida);
    }

    // O botão voltar do celular vai para a página anterior; o jogo usa isso para perguntar "Sair do jogo?".
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }
}
