<?php
/**
 * EGF — Service Data Menu v1.0
 *
 * A fast, single-screen admin tool for managing Main Category and Sub
 * Category taxonomy terms — instead of clicking through WordPress's
 * native per-term edit screens one at a time.
 *
 * IMPORTANT: This uses the SAME underlying WordPress functions as the
 * native screens (wp_insert_term, update_term_meta). Nothing here is a
 * separate data system — anything added/edited here shows up identically
 * on the normal taxonomy screens, and vice versa.
 *
 * NOTE ON TAXONOMY SLUG: Main Category's actual registered slug is
 * `main-category` (hyphen) — confirmed from the taxonomy's own settings
 * screen. This file uses that exact value throughout. Earlier snippets
 * in this project (listing/order page breadcrumbs) used `main_category`
 * (underscore) instead, which is a DIFFERENT taxonomy name to WordPress
 * and likely fails silently. Worth checking/fixing those files separately.
 *
 * Fields intentionally NOT managed here: main_cat_image, sub_cat_image
 * (media uploads need WordPress's media picker — left on the native
 * per-term screens since images are edited rarely).
 *
 * v1.1 CHANGES:
 * - Main/Sub Categories are now shown behind a tab filter (only one
 *   section visible at a time) instead of both stacked on one long page.
 * - Cards are paginated (one card per "page") with prev/next arrows and
 *   native swipe (CSS scroll-snap), instead of listing every card in a row.
 * - "Save All..." and "Add New..." forms now submit over AJAX (no page
 *   reload) and show a small toast notification on success/failure.
 * - Icon fields now offer a suggestion list (Font Awesome classes) via
 *   <datalist> while still accepting free text.
 * - "Add New Main Category": the Direct Link field only shows when
 *   "Has Sub-Categories?" is set to No.
 * - Description textareas auto-grow to fit their content — no internal
 *   scrolling, while editing or just viewing.
 * All original data/fields/sanitization are unchanged — same meta keys,
 * same taxonomies, same nonces.
 */

define('EGF_SCM_MAIN_TAX', 'main-category');
define('EGF_SCM_SUB_TAX', 'sub_category');

// ---------------------------------------------------------------
// Menu registration
// ---------------------------------------------------------------
add_action('admin_menu', function () {
    $egf_scm_hook = add_options_page(
        'Service Data Menu',
        'Service Data Menu',
        'manage_options',
        'egf-service-data-menu',
        'egf_scm_render_page'
    );

    // Font Awesome is only loaded on THIS admin page (needed so the icon
    // picker can actually show the icon pictures, not just class names).
    add_action('admin_print_styles-' . $egf_scm_hook, function () {
        wp_enqueue_style(
            'egf-scm-fontawesome',
            'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
            [],
            '6.5.1'
        );
    });
});

// ---------------------------------------------------------------
// Instant-save toggle endpoint (Status / Has Sub-Categories)
// ---------------------------------------------------------------
add_action('wp_ajax_egf_scm_toggle', function () {
    if (!current_user_can('manage_options')) {
        wp_send_json(['error' => 'Not allowed'], 403);
    }
    if (!isset($_POST['nonce']) || !wp_verify_nonce($_POST['nonce'], 'egf_scm_toggle')) {
        wp_send_json(['error' => 'Invalid request'], 403);
    }

    $term_id  = isset($_POST['term_id']) ? intval($_POST['term_id']) : 0;
    $meta_key = isset($_POST['meta_key']) ? sanitize_key($_POST['meta_key']) : '';
    $value    = isset($_POST['value']) ? sanitize_key($_POST['value']) : '';

    // Whitelist — only these exact key/value combos can ever be written here
    $allowed = [
        'main_cat_status'             => ['active', 'coming_soon'],
        'main_cat_has_subcategories'  => ['yes', 'no'],
        'sub_cat_status'              => ['available', 'coming_soon'],
    ];

    if (!$term_id || !isset($allowed[$meta_key]) || !in_array($value, $allowed[$meta_key], true)) {
        wp_send_json(['error' => 'Invalid field or value'], 400);
    }

    update_term_meta($term_id, $meta_key, $value);
    wp_send_json(['status' => 'ok']);
});

// ---------------------------------------------------------------
// Shared save/create helpers — used by BOTH the plain-POST fallback
// (page reloads if JS is unavailable) and the AJAX endpoints below,
// so the exact same logic runs either way.
// ---------------------------------------------------------------
if (!function_exists('egf_scm_save_main_rows')) {
    function egf_scm_save_main_rows($rows) {
        if (!is_array($rows)) return;
        foreach ($rows as $term_id => $fields) {
            $term_id = intval($term_id);
            if (!$term_id) continue;
            update_term_meta($term_id, 'main_cat_description', sanitize_textarea_field($fields['description'] ?? ''));
            update_term_meta($term_id, 'main_cat_icon', sanitize_text_field($fields['icon'] ?? ''));
            update_term_meta($term_id, 'main_cat_order', intval($fields['order'] ?? 0));
            update_term_meta($term_id, 'main_cat_link', esc_url_raw($fields['link'] ?? ''));
        }
    }
}

if (!function_exists('egf_scm_save_sub_rows')) {
    function egf_scm_save_sub_rows($rows) {
        if (!is_array($rows)) return;
        foreach ($rows as $term_id => $fields) {
            $term_id = intval($term_id);
            if (!$term_id) continue;
            update_term_meta($term_id, 'sub_cat_order', intval($fields['order'] ?? 0));
            update_term_meta($term_id, 'sub_cat_icon', sanitize_text_field($fields['icon'] ?? ''));
            update_term_meta($term_id, 'sub_cat_description', sanitize_textarea_field($fields['description'] ?? ''));
            $parent_id = intval($fields['parent'] ?? 0);
            if ($parent_id) {
                update_term_meta($term_id, 'sub_cat_parent', $parent_id);
            }
        }
    }
}

if (!function_exists('egf_scm_create_main')) {
    function egf_scm_create_main($name, $description, $icon, $order, $has_subs_input, $link) {
        $name = sanitize_text_field($name);
        if (!$name) {
            return ['success' => false, 'message' => 'Please provide a name.'];
        }

        $result = wp_insert_term($name, EGF_SCM_MAIN_TAX);
        if (is_wp_error($result)) {
            return ['success' => false, 'message' => 'Error: ' . $result->get_error_message()];
        }

        $new_id      = $result['term_id'];
        $description = sanitize_textarea_field($description);
        $icon        = sanitize_text_field($icon);
        $order       = intval($order);
        $has_subs    = sanitize_key($has_subs_input);
        $has_subs    = in_array($has_subs, ['yes', 'no'], true) ? $has_subs : 'no';
        $link        = esc_url_raw($link);

        update_term_meta($new_id, 'main_cat_description', $description);
        update_term_meta($new_id, 'main_cat_icon', $icon);
        update_term_meta($new_id, 'main_cat_order', $order);
        update_term_meta($new_id, 'main_cat_status', 'coming_soon');
        update_term_meta($new_id, 'main_cat_has_subcategories', $has_subs);
        update_term_meta($new_id, 'main_cat_link', $link);

        return [
            'success' => true,
            'message' => 'New Main Category "' . $name . '" created.',
            'term' => [
                'term_id'     => $new_id,
                'name'        => $name,
                'description' => $description,
                'icon'        => $icon,
                'order'       => $order,
                'has_subs'    => $has_subs,
                'link'        => $link,
            ],
        ];
    }
}

if (!function_exists('egf_scm_create_sub')) {
    function egf_scm_create_sub($name, $parent_id, $order, $icon = '', $description = '') {
        $name      = sanitize_text_field($name);
        $parent_id = intval($parent_id);

        if (!$name || !$parent_id) {
            return ['success' => false, 'message' => 'Please provide a name and pick a parent category.'];
        }

        $result = wp_insert_term($name, EGF_SCM_SUB_TAX);
        if (is_wp_error($result)) {
            return ['success' => false, 'message' => 'Error: ' . $result->get_error_message()];
        }

        $new_id      = $result['term_id'];
        $order       = intval($order);
        $icon        = sanitize_text_field($icon);
        $description = sanitize_textarea_field($description);

        update_term_meta($new_id, 'sub_cat_parent', $parent_id);
        update_term_meta($new_id, 'sub_cat_order', $order);
        update_term_meta($new_id, 'sub_cat_status', 'coming_soon');
        update_term_meta($new_id, 'sub_cat_icon', $icon);
        update_term_meta($new_id, 'sub_cat_description', $description);

        return [
            'success' => true,
            'message' => 'New Sub Category "' . $name . '" created.',
            'term' => [
                'term_id'     => $new_id,
                'name'        => $name,
                'parent_id'   => $parent_id,
                'order'       => $order,
                'icon'        => $icon,
                'description' => $description,
            ],
        ];
    }
}

// ---------------------------------------------------------------
// AJAX endpoints — power the no-reload "Save All..." / "Add New..."
// forms. Same nonce actions and same whitelisted fields as the
// plain-POST fallback further down.
// ---------------------------------------------------------------
add_action('wp_ajax_egf_scm_save_main_ajax', function () {
    if (!current_user_can('manage_options')) {
        wp_send_json(['status' => 'error', 'message' => 'Not allowed'], 403);
    }
    if (!isset($_POST['egf_scm_nonce']) || !wp_verify_nonce($_POST['egf_scm_nonce'], 'egf_scm_save_main')) {
        wp_send_json(['status' => 'error', 'message' => 'Security check failed. Please refresh the page and try again.'], 403);
    }
    $rows = isset($_POST['main']) && is_array($_POST['main']) ? $_POST['main'] : [];
    egf_scm_save_main_rows($rows);
    wp_send_json(['status' => 'ok', 'message' => 'Main Categories updated.']);
});

add_action('wp_ajax_egf_scm_save_sub_ajax', function () {
    if (!current_user_can('manage_options')) {
        wp_send_json(['status' => 'error', 'message' => 'Not allowed'], 403);
    }
    if (!isset($_POST['egf_scm_nonce']) || !wp_verify_nonce($_POST['egf_scm_nonce'], 'egf_scm_save_sub')) {
        wp_send_json(['status' => 'error', 'message' => 'Security check failed. Please refresh the page and try again.'], 403);
    }
    $rows = isset($_POST['sub']) && is_array($_POST['sub']) ? $_POST['sub'] : [];
    egf_scm_save_sub_rows($rows);
    wp_send_json(['status' => 'ok', 'message' => 'Sub Categories updated.']);
});

add_action('wp_ajax_egf_scm_add_main_ajax', function () {
    if (!current_user_can('manage_options')) {
        wp_send_json(['status' => 'error', 'message' => 'Not allowed'], 403);
    }
    if (!isset($_POST['egf_scm_nonce']) || !wp_verify_nonce($_POST['egf_scm_nonce'], 'egf_scm_add_main')) {
        wp_send_json(['status' => 'error', 'message' => 'Security check failed. Please refresh the page and try again.'], 403);
    }
    $result = egf_scm_create_main(
        $_POST['new_main_name'] ?? '',
        $_POST['new_main_description'] ?? '',
        $_POST['new_main_icon'] ?? '',
        $_POST['new_main_order'] ?? 0,
        $_POST['new_main_has_subs'] ?? 'no',
        $_POST['new_main_link'] ?? ''
    );
    if ($result['success']) {
        wp_send_json(['status' => 'ok', 'message' => $result['message'], 'term' => $result['term']]);
    } else {
        wp_send_json(['status' => 'error', 'message' => $result['message']], 400);
    }
});

add_action('wp_ajax_egf_scm_add_sub_ajax', function () {
    if (!current_user_can('manage_options')) {
        wp_send_json(['status' => 'error', 'message' => 'Not allowed'], 403);
    }
    if (!isset($_POST['egf_scm_nonce']) || !wp_verify_nonce($_POST['egf_scm_nonce'], 'egf_scm_add_sub')) {
        wp_send_json(['status' => 'error', 'message' => 'Security check failed. Please refresh the page and try again.'], 403);
    }
    $result = egf_scm_create_sub(
        $_POST['new_sub_name'] ?? '',
        $_POST['new_sub_parent'] ?? 0,
        $_POST['new_sub_order'] ?? 0,
        $_POST['new_sub_icon'] ?? '',
        $_POST['new_sub_description'] ?? ''
    );
    if ($result['success']) {
        wp_send_json(['status' => 'ok', 'message' => $result['message'], 'term' => $result['term']]);
    } else {
        wp_send_json(['status' => 'error', 'message' => $result['message']], 400);
    }
});

// ---------------------------------------------------------------
// Page render + form processing
// ---------------------------------------------------------------
if (!function_exists('egf_scm_render_page')) {
    function egf_scm_render_page() {
        if (!current_user_can('manage_options')) return;

        $notice = '';

        // ---------- Bulk save: Main Categories (fallback if JS is off) ----------
        if (
            isset($_POST['egf_scm_action']) && $_POST['egf_scm_action'] === 'save_main' &&
            isset($_POST['egf_scm_nonce']) && wp_verify_nonce($_POST['egf_scm_nonce'], 'egf_scm_save_main')
        ) {
            $rows = isset($_POST['main']) && is_array($_POST['main']) ? $_POST['main'] : [];
            egf_scm_save_main_rows($rows);
            $notice = 'Main Categories updated.';
        }

        // ---------- Bulk save: Sub Categories (fallback if JS is off) ----------
        if (
            isset($_POST['egf_scm_action']) && $_POST['egf_scm_action'] === 'save_sub' &&
            isset($_POST['egf_scm_nonce']) && wp_verify_nonce($_POST['egf_scm_nonce'], 'egf_scm_save_sub')
        ) {
            $rows = isset($_POST['sub']) && is_array($_POST['sub']) ? $_POST['sub'] : [];
            egf_scm_save_sub_rows($rows);
            $notice = 'Sub Categories updated.';
        }

        // ---------- Add new Main Category (fallback if JS is off) ----------
        if (
            isset($_POST['egf_scm_action']) && $_POST['egf_scm_action'] === 'add_main' &&
            isset($_POST['egf_scm_nonce']) && wp_verify_nonce($_POST['egf_scm_nonce'], 'egf_scm_add_main')
        ) {
            $result = egf_scm_create_main(
                $_POST['new_main_name'] ?? '',
                $_POST['new_main_description'] ?? '',
                $_POST['new_main_icon'] ?? '',
                $_POST['new_main_order'] ?? 0,
                $_POST['new_main_has_subs'] ?? 'no',
                $_POST['new_main_link'] ?? ''
            );
            $notice = $result['message'];
        }

        // ---------- Add new Sub Category (fallback if JS is off) ----------
        if (
            isset($_POST['egf_scm_action']) && $_POST['egf_scm_action'] === 'add_sub' &&
            isset($_POST['egf_scm_nonce']) && wp_verify_nonce($_POST['egf_scm_nonce'], 'egf_scm_add_sub')
        ) {
            $result = egf_scm_create_sub(
                $_POST['new_sub_name'] ?? '',
                $_POST['new_sub_parent'] ?? 0,
                $_POST['new_sub_order'] ?? 0,
                $_POST['new_sub_icon'] ?? '',
                $_POST['new_sub_description'] ?? ''
            );
            $notice = $result['message'];
        }

        // ---------- Fetch data for display ----------
        $main_terms = get_terms(['taxonomy' => EGF_SCM_MAIN_TAX, 'hide_empty' => false]);
        if (is_wp_error($main_terms)) $main_terms = [];

        usort($main_terms, function ($a, $b) {
            return intval(get_term_meta($a->term_id, 'main_cat_order', true)) <=> intval(get_term_meta($b->term_id, 'main_cat_order', true));
        });

        $sub_terms = get_terms(['taxonomy' => EGF_SCM_SUB_TAX, 'hide_empty' => false]);
        if (is_wp_error($sub_terms)) $sub_terms = [];

        // Main categories eligible to be a parent (has_subcategories = yes)
        $parent_options = array_filter($main_terms, function ($t) {
            return get_term_meta($t->term_id, 'main_cat_has_subcategories', true) === 'yes';
        });

        // Group sub categories by parent ID
        $subs_by_parent = [];
        foreach ($sub_terms as $sub) {
            $parent_id = intval(get_term_meta($sub->term_id, 'sub_cat_parent', true));
            $subs_by_parent[$parent_id][] = $sub;
        }
        foreach ($subs_by_parent as $pid => $list) {
            usort($subs_by_parent[$pid], function ($a, $b) {
                return intval(get_term_meta($a->term_id, 'sub_cat_order', true)) <=> intval(get_term_meta($b->term_id, 'sub_cat_order', true));
            });
        }

        ?>
        <div class="wrap egf-scm-wrap">
            <h1>Service Data Menu</h1>
            <p>Manage Main Category and Sub Category data here — same underlying data as the native taxonomy screens, just faster to edit. Category images still need the native term-edit screen.</p>

            <?php if ($notice): ?>
                <div class="notice notice-success is-dismissible"><p><?php echo esc_html($notice); ?></p></div>
            <?php endif; ?>

            <datalist id="egf-scm-icon-list">
                <option value="fa-file-invoice">
                <option value="fa-file-invoice-dollar">
                <option value="fa-mobile-screen">
                <option value="fa-sim-card">
                <option value="fa-wallet">
                <option value="fa-money-bill-transfer">
                <option value="fa-credit-card">
                <option value="fa-receipt">
                <option value="fa-graduation-cap">
                <option value="fa-user-graduate">
                <option value="fa-school">
                <option value="fa-book">
                <option value="fa-id-card">
                <option value="fa-desktop">
                <option value="fa-newspaper">
                <option value="fa-bolt">
                <option value="fa-house">
                <option value="fa-phone">
                <option value="fa-tv">
                <option value="fa-wifi">
                <option value="fa-gas-pump">
                <option value="fa-plane">
                <option value="fa-shield-halved">
                <option value="fa-briefcase">
                <option value="fa-globe">
                <option value="fa-envelope">
                <option value="fa-headset">
                <option value="fa-gift">
                <option value="fa-cart-shopping">
                <option value="fa-chart-line">
                <option value="fa-download">
                <option value="fa-upload">
                <option value="fa-clipboard-question">
                <option value="fa-square-poll-vertical">
                <option value="fa-certificate">
                <option value="fa-award">
                <option value="fa-video">
                <option value="fa-circle-play">
                <option value="fa-calendar-days">
                <option value="fa-clock">
                <option value="fa-bell">
                <option value="fa-lock">
                <option value="fa-lock-open">
                <option value="fa-database">
                <option value="fa-server">
                <option value="fa-network-wired">
                <option value="fa-satellite-dish">
                <option value="fa-gauge-high">
                <option value="fa-list-check">
                <option value="fa-folder-open">
                <option value="fa-print">
                <option value="fa-tags">
                <option value="fa-comments">
                <option value="fa-share-nodes">
                <option value="fa-magnifying-glass">
                <option value="fa-robot">
                <option value="fa-microchip">
                <option value="fa-code">
                <option value="fa-terminal">
                <option value="fa-users">
                <option value="fa-star">
                <option value="fa-trophy">
                <option value="fa-medal">
                <option value="fa-gears">
                <option value="fa-truck-fast">
                <option value="fa-building-columns">
                <option value="fa-piggy-bank">
                <option value="fa-hand-holding-dollar">
                <option value="fa-coins">
                <option value="fa-percent">
                <option value="fa-clipboard-list">
                <option value="fa-pen-to-square">
                <option value="fa-file-pdf">
                <option value="fa-headphones-simple">
                <option value="fa-lightbulb">
            </datalist>

            <div class="egf-scm-icon-modal" id="egf-scm-icon-modal">
                <div class="egf-scm-icon-modal-inner">
                    <div class="egf-scm-icon-modal-header">
                        <input type="text" class="egf-scm-icon-modal-search" placeholder="Search icons...">
                        <button type="button" class="egf-scm-icon-modal-close" aria-label="Close">✕</button>
                    </div>
                    <div class="egf-scm-icon-modal-grid"></div>
                </div>
            </div>

            <style>
                .egf-scm-wrap { max-width: 1100px; }

                .egf-scm-tabs { display:flex; gap:8px; margin: 16px 0 20px; flex-wrap: wrap; }
                .egf-scm-tab-btn {
                    background:#f0f0f1; border:1px solid #c3c4c7; border-radius:4px;
                    padding:8px 16px; font-size:13px; font-weight:600; cursor:pointer; color:#2c3338;
                }
                .egf-scm-tab-btn.egf-scm-tab-active { background:#2271b1; color:#fff; border-color:#2271b1; }
                .egf-scm-section { display:none; }
                .egf-scm-section.egf-scm-section-active { display:block; }

                .egf-scm-pager-wrap { margin: 20px 0; }

                .egf-scm-subfilter { position: relative; max-width: 340px; margin: 4px 0 22px; }
                .egf-scm-subfilter-btn {
                    display: flex; align-items: center; justify-content: space-between; gap: 10px;
                    width: 100%; background: #fff; border: 1px solid #dcdcde; border-radius: 10px;
                    padding: 12px 16px; font-size: 14px; font-weight: 600; color: #1d2327;
                    cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.04);
                }
                .egf-scm-subfilter-btn:hover { border-color: #2271b1; }
                .egf-scm-subfilter-caret { font-size: 11px; color: #787c82; transition: transform .15s ease; }
                .egf-scm-subfilter-btn[aria-expanded="true"] .egf-scm-subfilter-caret { transform: rotate(180deg); }
                .egf-scm-subfilter-panel {
                    position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 20;
                    background: #fff; border: 1px solid #dcdcde; border-radius: 10px;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.14);
                    max-height: 280px; overflow-y: auto; padding: 6px;
                }
                .egf-scm-subfilter-option {
                    display: block; width: 100%; text-align: left; background: none; border: none;
                    padding: 10px 12px; font-size: 14px; color: #1d2327; border-radius: 6px; cursor: pointer;
                }
                .egf-scm-subfilter-option:hover { background: #f0f0f1; }
                .egf-scm-subfilter-option-active { background: #2271b1; color: #fff; }
                .egf-scm-subfilter-option-active:hover { background: #2271b1; }
                .egf-scm-subgroup-hidden { display: none; }
                .egf-scm-grid {
                    display: flex;
                    align-items: flex-start;
                    overflow-x: auto;
                    scroll-snap-type: x mandatory;
                    -webkit-overflow-scrolling: touch;
                    scrollbar-width: none;
                }
                .egf-scm-grid::-webkit-scrollbar { display: none; }
                .egf-scm-grid > .egf-scm-page {
                    flex: 0 0 100%;
                    scroll-snap-align: start;
                    scroll-snap-stop: always;
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                    min-width: 0;
                }
                .egf-scm-pager-controls {
                    display:flex; align-items:center; justify-content:center; gap:14px; margin-top:3px;
                }
                .egf-scm-pager-btn {
                    background:#2271b1; color:#fff; border:none; border-radius:50%;
                    width:34px; height:34px; font-size:18px; line-height:1; cursor:pointer;
                }
                .egf-scm-pager-btn:disabled { background:#c3c4c7; cursor:default; }
                .egf-scm-pager-count { font-size:12px; color:#555; min-width:56px; text-align:center; }

                .egf-scm-card {
                    background: #fff;
                    border: 1px solid #dcdcde;
                    border-radius: 6px;
                    padding: 14px 16px;
                    box-sizing: border-box;
                    min-width: 0;
                }
                .egf-scm-card h3 {
                    margin: 0 0 10px;
                    font-size: 15px;
                    word-break: break-word;
                }
                .egf-scm-field { margin-bottom: 10px; }
                .egf-scm-field label {
                    display: block;
                    font-size: 12px;
                    font-weight: 600;
                    color: #555;
                    margin-bottom: 3px;
                }
                .egf-scm-field input[type="text"],
                .egf-scm-field input[type="number"],
                .egf-scm-field input[type="url"],
                .egf-scm-field textarea,
                .egf-scm-field select {
                    width: 100%;
                    box-sizing: border-box;
                    max-width: 100%;
                }
                .egf-scm-field textarea { min-height: 60px; resize: none; overflow: hidden; }

                .egf-scm-order-warning {
                    display: block;
                    font-size: 12px;
                    font-weight: 600;
                    color: #d63638;
                    margin-top: 4px;
                }
                .egf-scm-order-warning:empty { display: none; }

                .egf-scm-toggle-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    margin-bottom: 10px;
                }
                .egf-scm-toggle-row label { font-size: 12px; font-weight: 600; color: #555; }
                .egf-scm-switch {
                    position: relative;
                    display: inline-block;
                    width: 42px;
                    height: 22px;
                    flex-shrink: 0;
                }
                .egf-scm-switch input { opacity: 0; width: 0; height: 0; }
                .egf-scm-slider {
                    position: absolute; cursor: pointer;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background-color: #ccc;
                    transition: .2s;
                    border-radius: 22px;
                }
                .egf-scm-slider:before {
                    position: absolute; content: "";
                    height: 16px; width: 16px;
                    left: 3px; bottom: 3px;
                    background-color: white;
                    transition: .2s;
                    border-radius: 50%;
                }
                .egf-scm-switch input:checked + .egf-scm-slider { background-color: #2271b1; }
                .egf-scm-switch input:checked + .egf-scm-slider:before { transform: translateX(20px); }
                .egf-scm-toggle-status {
                    font-size: 11px;
                    color: #787c82;
                    margin-left: 6px;
                }

                .egf-scm-link-field.egf-scm-hidden { display: none; }

                .egf-scm-section-heading {
                    margin-top: 34px;
                    padding-top: 14px;
                    border-top: 2px solid #dcdcde;
                }
                .egf-scm-add-box {
                    background: #f6f7f7;
                    border: 1px dashed #c3c4c7;
                    border-radius: 6px;
                    padding: 16px;
                    margin-top: 24px;
                }
                .egf-scm-add-box h3 { margin-top: 0; }
                .egf-scm-add-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 12px;
                    margin-bottom: 12px;
                }
                @media (max-width: 480px) {
                    .egf-scm-add-grid { grid-template-columns: 1fr; }
                }

                .egf-scm-toast {
                    position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 20px);
                    background: #1d2327; color: #fff; padding: 10px 18px; border-radius: 6px;
                    font-size: 13px; opacity: 0; transition: opacity .25s, transform .25s;
                    z-index: 100000; max-width: 90vw; text-align: center;
                    pointer-events: none;
                }
                .egf-scm-toast-show { opacity: 1; transform: translate(-50%, 0); }
                .egf-scm-toast-error { background: #a00; }

                .egf-scm-icon-row { display: flex; align-items: center; gap: 8px; }
                .egf-scm-icon-preview {
                    width: 36px; height: 36px; flex-shrink: 0;
                    border: 1px solid #dcdcde; border-radius: 4px;
                    display: flex; align-items: center; justify-content: center;
                    background: #f6f7f7; font-size: 16px; color: #2271b1;
                }
                .egf-scm-icon-row input[type="text"] { flex: 1 1 auto; min-width: 0; }
                .egf-scm-icon-pick-btn {
                    flex-shrink: 0; background: #2271b1; color: #fff; border: none;
                    border-radius: 4px; padding: 8px 10px; font-size: 12px; cursor: pointer;
                    white-space: nowrap;
                }

                .egf-scm-icon-modal {
                    display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5);
                    z-index: 100001; align-items: center; justify-content: center; padding: 16px;
                }
                .egf-scm-icon-modal.egf-scm-icon-modal-open { display: flex; }
                .egf-scm-icon-modal-inner {
                    background: #fff; border-radius: 8px; max-width: 480px; width: 100%;
                    max-height: 80vh; display: flex; flex-direction: column; overflow: hidden;
                }
                .egf-scm-icon-modal-header {
                    display: flex; align-items: center; gap: 8px; padding: 12px;
                    border-bottom: 1px solid #dcdcde;
                }
                .egf-scm-icon-modal-search {
                    flex: 1 1 auto; box-sizing: border-box; padding: 8px;
                    border: 1px solid #c3c4c7; border-radius: 4px; font-size: 14px;
                }
                .egf-scm-icon-modal-close {
                    background: none; border: none; font-size: 18px; cursor: pointer;
                    color: #555; flex-shrink: 0;
                }
                .egf-scm-icon-modal-grid {
                    display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
                    gap: 8px; padding: 12px; overflow-y: auto;
                }
                .egf-scm-icon-option {
                    display: flex; flex-direction: column; align-items: center; gap: 4px;
                    background: #f6f7f7; border: 1px solid #dcdcde; border-radius: 6px;
                    padding: 10px 4px; cursor: pointer; font-size: 10px; color: #2c3338;
                }
                .egf-scm-icon-option i { font-size: 18px; color: #2271b1; }
                .egf-scm-icon-option:hover, .egf-scm-icon-option:active {
                    background: #e5f0f8; border-color: #2271b1;
                }
            </style>

            <div class="egf-scm-tabs">
                <button type="button" class="egf-scm-tab-btn egf-scm-tab-active" data-egf-tab="main">Main Categories</button>
                <button type="button" class="egf-scm-tab-btn" data-egf-tab="sub">Sub Categories</button>
            </div>

            <!-- ============ MAIN CATEGORIES ============ -->
            <div class="egf-scm-section egf-scm-section-active" data-egf-section="main">
            <h2>Main Categories</h2>
            <form method="post" class="egf-scm-ajax-form">
                <?php wp_nonce_field('egf_scm_save_main', 'egf_scm_nonce'); ?>
                <input type="hidden" name="egf_scm_action" value="save_main">
                <input type="hidden" name="action" value="egf_scm_save_main_ajax">

                <div class="egf-scm-pager-wrap">
                    <div class="egf-scm-grid" id="egf-scm-main-grid">
                        <?php foreach ($main_terms as $term):
                            $tid           = $term->term_id;
                            $description   = get_term_meta($tid, 'main_cat_description', true);
                            $icon          = get_term_meta($tid, 'main_cat_icon', true);
                            $order         = get_term_meta($tid, 'main_cat_order', true);
                            $status        = get_term_meta($tid, 'main_cat_status', true) ?: 'coming_soon';
                            $has_subs      = get_term_meta($tid, 'main_cat_has_subcategories', true) ?: 'no';
                            $link          = get_term_meta($tid, 'main_cat_link', true);
                        ?>
                            <div class="egf-scm-card" data-term-id="<?php echo esc_attr($tid); ?>">
                                <h3><?php echo esc_html($term->name); ?></h3>

                                <div class="egf-scm-toggle-row">
                                    <label>Status</label>
                                    <span>
                                        <label class="egf-scm-switch">
                                            <input type="checkbox" class="egf-scm-live-toggle"
                                                   data-term-id="<?php echo esc_attr($tid); ?>"
                                                   data-meta-key="main_cat_status"
                                                   data-on-value="active" data-off-value="coming_soon"
                                                   <?php checked($status, 'active'); ?>>
                                            <span class="egf-scm-slider"></span>
                                        </label>
                                        <span class="egf-scm-toggle-status"><?php echo $status === 'active' ? 'Active' : 'Coming Soon'; ?></span>
                                    </span>
                                </div>

                                <div class="egf-scm-toggle-row">
                                    <label>Has Sub-Categories?</label>
                                    <span>
                                        <label class="egf-scm-switch">
                                            <input type="checkbox" class="egf-scm-live-toggle egf-scm-has-subs-toggle"
                                                   data-term-id="<?php echo esc_attr($tid); ?>"
                                                   data-meta-key="main_cat_has_subcategories"
                                                   data-on-value="yes" data-off-value="no"
                                                   <?php checked($has_subs, 'yes'); ?>>
                                            <span class="egf-scm-slider"></span>
                                        </label>
                                        <span class="egf-scm-toggle-status"><?php echo $has_subs === 'yes' ? 'Yes' : 'No'; ?></span>
                                    </span>
                                </div>

                                <div class="egf-scm-field">
                                    <label>Icon (Font Awesome class)</label>
                                    <div class="egf-scm-icon-row">
                                        <span class="egf-scm-icon-preview"><i class="fa-solid <?php echo esc_attr($icon); ?>"></i></span>
                                        <input type="text" class="egf-scm-icon-text" name="main[<?php echo esc_attr($tid); ?>][icon]" value="<?php echo esc_attr($icon); ?>" placeholder="fa-desktop" list="egf-scm-icon-list">
                                        <button type="button" class="egf-scm-icon-pick-btn">Choose</button>
                                    </div>
                                </div>

                                <div class="egf-scm-field">
                                    <label>Display Order</label>
                                    <input type="number" class="egf-scm-order-input" name="main[<?php echo esc_attr($tid); ?>][order]" value="<?php echo esc_attr($order); ?>">
                                    <span class="egf-scm-order-warning" aria-live="polite"></span>
                                </div>

                                <div class="egf-scm-field">
                                    <label>Description</label>
                                    <textarea name="main[<?php echo esc_attr($tid); ?>][description]"><?php echo esc_textarea($description); ?></textarea>
                                </div>

                                <div class="egf-scm-field egf-scm-link-field <?php echo $has_subs === 'yes' ? 'egf-scm-hidden' : ''; ?>" data-link-for="<?php echo esc_attr($tid); ?>">
                                    <label>Direct Link (only used when there are no sub-categories)</label>
                                    <input type="url" name="main[<?php echo esc_attr($tid); ?>][link]" value="<?php echo esc_attr($link); ?>" placeholder="https://...">
                                </div>
                            </div>
                        <?php endforeach; ?>
                    </div>
                    <div class="egf-scm-pager-controls">
                        <button type="button" class="egf-scm-pager-btn egf-scm-pager-prev" aria-label="Previous">‹</button>
                        <span class="egf-scm-pager-count"></span>
                        <button type="button" class="egf-scm-pager-btn egf-scm-pager-next" aria-label="Next">›</button>
                    </div>
                </div>

                <?php submit_button('Save All Main Category Changes'); ?>
            </form>

            <div class="egf-scm-add-box">
                <h3>+ Add New Main Category</h3>
                <form method="post" class="egf-scm-ajax-form">
                    <?php wp_nonce_field('egf_scm_add_main', 'egf_scm_nonce'); ?>
                    <input type="hidden" name="egf_scm_action" value="add_main">
                    <input type="hidden" name="action" value="egf_scm_add_main_ajax">
                    <div class="egf-scm-add-grid">
                        <div class="egf-scm-field">
                            <label>Name</label>
                            <input type="text" name="new_main_name" required>
                        </div>
                        <div class="egf-scm-field">
                            <label>Icon (Font Awesome class)</label>
                            <div class="egf-scm-icon-row">
                                <span class="egf-scm-icon-preview"><i class="fa-solid"></i></span>
                                <input type="text" class="egf-scm-icon-text" name="new_main_icon" placeholder="fa-desktop" list="egf-scm-icon-list">
                                <button type="button" class="egf-scm-icon-pick-btn">Choose</button>
                            </div>
                        </div>
                        <div class="egf-scm-field">
                            <label>Display Order</label>
                            <input type="number" class="egf-scm-order-input" name="new_main_order" value="0" data-egf-order-scope="new-main">
                            <span class="egf-scm-order-warning" aria-live="polite"></span>
                        </div>
                        <div class="egf-scm-field">
                            <label>Has Sub-Categories?</label>
                            <select name="new_main_has_subs" id="egf-scm-new-main-has-subs">
                                <option value="no">No</option>
                                <option value="yes">Yes</option>
                            </select>
                        </div>
                        <div class="egf-scm-field egf-scm-link-field" id="egf-scm-new-main-link-field">
                            <label>Direct Link (if no sub-categories)</label>
                            <input type="url" name="new_main_link" placeholder="https://...">
                        </div>
                        <div class="egf-scm-field">
                            <label>Description</label>
                            <textarea name="new_main_description"></textarea>
                        </div>
                    </div>
                    <p class="description">New categories start as "Coming Soon" — flip the toggle above once it's ready.</p>
                    <?php submit_button('Add Main Category', 'secondary'); ?>
                </form>
            </div>
            </div>

            <!-- ============ SUB CATEGORIES ============ -->
            <div class="egf-scm-section" data-egf-section="sub">
            <div class="egf-scm-section-heading">
                <h2>Sub Categories</h2>
            </div>

            <?php
            // Pre-check (for the filter dropdown only) whether any orphaned sub-categories
            // exist, so we know whether to list an "Unassigned" option. The actual orphan
            // loop further down still does its own computation — this is just a read.
            $egf_scm_filter_known_pids = wp_list_pluck($main_terms, 'term_id');
            $egf_scm_filter_orphan_ids = array_diff(array_keys($subs_by_parent), $egf_scm_filter_known_pids);
            $egf_scm_has_orphans = false;
            foreach ($egf_scm_filter_orphan_ids as $egf_scm_opid) {
                if (!empty($subs_by_parent[$egf_scm_opid])) { $egf_scm_has_orphans = true; break; }
            }
            ?>
            <div class="egf-scm-subfilter" id="egf-scm-subfilter">
                <button type="button" class="egf-scm-subfilter-btn" id="egf-scm-subfilter-btn" aria-haspopup="listbox" aria-expanded="false">
                    <span class="egf-scm-subfilter-label">All Categories</span>
                    <span class="egf-scm-subfilter-caret">▾</span>
                </button>
                <div class="egf-scm-subfilter-panel" id="egf-scm-subfilter-panel" role="listbox" hidden>
                    <button type="button" class="egf-scm-subfilter-option egf-scm-subfilter-option-active" data-filter-value="all" role="option" aria-selected="true">All Categories</button>
                    <?php foreach ($main_terms as $egf_scm_pt):
                        $egf_scm_fpid = $egf_scm_pt->term_id;
                        if (empty($subs_by_parent[$egf_scm_fpid])) continue;
                    ?>
                        <button type="button" class="egf-scm-subfilter-option" data-filter-value="<?php echo esc_attr($egf_scm_fpid); ?>" role="option" aria-selected="false"><?php echo esc_html($egf_scm_pt->name); ?></button>
                    <?php endforeach; ?>
                    <?php if ($egf_scm_has_orphans): ?>
                        <button type="button" class="egf-scm-subfilter-option" data-filter-value="orphans" role="option" aria-selected="false">Unassigned / Unknown Parent</button>
                    <?php endif; ?>
                </div>
            </div>

            <form method="post" class="egf-scm-ajax-form">
                <?php wp_nonce_field('egf_scm_save_sub', 'egf_scm_nonce'); ?>
                <input type="hidden" name="egf_scm_action" value="save_sub">
                <input type="hidden" name="action" value="egf_scm_save_sub_ajax">

                <?php foreach ($main_terms as $parent_term):
                    $pid = $parent_term->term_id;
                    if (empty($subs_by_parent[$pid])) continue;
                ?>
                    <div class="egf-scm-subgroup" data-group-parent="<?php echo esc_attr($pid); ?>">
                    <h3><?php echo esc_html($parent_term->name); ?></h3>
                    <div class="egf-scm-pager-wrap">
                        <div class="egf-scm-grid" data-parent-group="<?php echo esc_attr($pid); ?>">
                            <?php foreach ($subs_by_parent[$pid] as $sub):
                                $sid    = $sub->term_id;
                                $order  = get_term_meta($sid, 'sub_cat_order', true);
                                $status = get_term_meta($sid, 'sub_cat_status', true) ?: 'coming_soon';
                                $sicon  = get_term_meta($sid, 'sub_cat_icon', true);
                                $sdesc  = get_term_meta($sid, 'sub_cat_description', true);
                            ?>
                                <div class="egf-scm-card" data-term-id="<?php echo esc_attr($sid); ?>">
                                    <h3><?php echo esc_html($sub->name); ?></h3>

                                    <div class="egf-scm-toggle-row">
                                        <label>Status</label>
                                        <span>
                                            <label class="egf-scm-switch">
                                                <input type="checkbox" class="egf-scm-live-toggle"
                                                       data-term-id="<?php echo esc_attr($sid); ?>"
                                                       data-meta-key="sub_cat_status"
                                                       data-on-value="available" data-off-value="coming_soon"
                                                       <?php checked($status, 'available'); ?>>
                                                <span class="egf-scm-slider"></span>
                                            </label>
                                            <span class="egf-scm-toggle-status"><?php echo $status === 'available' ? 'Available' : 'Coming Soon'; ?></span>
                                        </span>
                                    </div>

                                    <div class="egf-scm-field">
                                        <label>Icon (Font Awesome class)</label>
                                        <div class="egf-scm-icon-row">
                                            <span class="egf-scm-icon-preview"><i class="fa-solid <?php echo esc_attr($sicon); ?>"></i></span>
                                            <input type="text" class="egf-scm-icon-text" name="sub[<?php echo esc_attr($sid); ?>][icon]" value="<?php echo esc_attr($sicon); ?>" placeholder="fa-concierge-bell" list="egf-scm-icon-list">
                                            <button type="button" class="egf-scm-icon-pick-btn">Choose</button>
                                        </div>
                                    </div>

                                    <div class="egf-scm-field">
                                        <label>Parent Category</label>
                                        <select name="sub[<?php echo esc_attr($sid); ?>][parent]">
                                            <?php foreach ($parent_options as $opt): ?>
                                                <option value="<?php echo esc_attr($opt->term_id); ?>" <?php selected($pid, $opt->term_id); ?>>
                                                    <?php echo esc_html($opt->name); ?>
                                                </option>
                                            <?php endforeach; ?>
                                        </select>
                                    </div>

                                    <div class="egf-scm-field">
                                        <label>Display Order</label>
                                        <input type="number" class="egf-scm-order-input" name="sub[<?php echo esc_attr($sid); ?>][order]" value="<?php echo esc_attr($order); ?>">
                                        <span class="egf-scm-order-warning" aria-live="polite"></span>
                                    </div>

                                    <div class="egf-scm-field">
                                        <label>Description</label>
                                        <textarea name="sub[<?php echo esc_attr($sid); ?>][description]"><?php echo esc_textarea($sdesc); ?></textarea>
                                    </div>
                                </div>
                            <?php endforeach; ?>
                        </div>
                        <div class="egf-scm-pager-controls">
                            <button type="button" class="egf-scm-pager-btn egf-scm-pager-prev" aria-label="Previous">‹</button>
                            <span class="egf-scm-pager-count"></span>
                            <button type="button" class="egf-scm-pager-btn egf-scm-pager-next" aria-label="Next">›</button>
                        </div>
                    </div>
                    </div>
                <?php endforeach; ?>

                <?php
                // Any sub-categories whose parent no longer qualifies (orphaned) — still show, so nothing is silently lost
                $known_parent_ids = wp_list_pluck($main_terms, 'term_id');
                $orphans = array_diff(array_keys($subs_by_parent), $known_parent_ids);
                foreach ($orphans as $orphan_pid):
                    if (empty($subs_by_parent[$orphan_pid])) continue;
                ?>
                    <div class="egf-scm-subgroup" data-group-parent="orphans">
                    <h3>Unassigned / Unknown Parent</h3>
                    <div class="egf-scm-pager-wrap">
                        <div class="egf-scm-grid" data-parent-group="<?php echo esc_attr($orphan_pid); ?>">
                            <?php foreach ($subs_by_parent[$orphan_pid] as $sub):
                                $sid    = $sub->term_id;
                                $order  = get_term_meta($sid, 'sub_cat_order', true);
                                $sicon  = get_term_meta($sid, 'sub_cat_icon', true);
                                $sdesc  = get_term_meta($sid, 'sub_cat_description', true);
                            ?>
                                <div class="egf-scm-card" data-term-id="<?php echo esc_attr($sid); ?>">
                                    <h3><?php echo esc_html($sub->name); ?></h3>
                                    <div class="egf-scm-field">
                                        <label>Icon (Font Awesome class)</label>
                                        <div class="egf-scm-icon-row">
                                            <span class="egf-scm-icon-preview"><i class="fa-solid <?php echo esc_attr($sicon); ?>"></i></span>
                                            <input type="text" class="egf-scm-icon-text" name="sub[<?php echo esc_attr($sid); ?>][icon]" value="<?php echo esc_attr($sicon); ?>" placeholder="fa-concierge-bell" list="egf-scm-icon-list">
                                            <button type="button" class="egf-scm-icon-pick-btn">Choose</button>
                                        </div>
                                    </div>
                                    <div class="egf-scm-field">
                                        <label>Parent Category</label>
                                        <select name="sub[<?php echo esc_attr($sid); ?>][parent]">
                                            <option value="">— Select —</option>
                                            <?php foreach ($parent_options as $opt): ?>
                                                <option value="<?php echo esc_attr($opt->term_id); ?>"><?php echo esc_html($opt->name); ?></option>
                                            <?php endforeach; ?>
                                        </select>
                                    </div>
                                    <div class="egf-scm-field">
                                        <label>Display Order</label>
                                        <input type="number" class="egf-scm-order-input" name="sub[<?php echo esc_attr($sid); ?>][order]" value="<?php echo esc_attr($order); ?>">
                                        <span class="egf-scm-order-warning" aria-live="polite"></span>
                                    </div>
                                    <div class="egf-scm-field">
                                        <label>Description</label>
                                        <textarea name="sub[<?php echo esc_attr($sid); ?>][description]"><?php echo esc_textarea($sdesc); ?></textarea>
                                    </div>
                                </div>
                            <?php endforeach; ?>
                        </div>
                        <div class="egf-scm-pager-controls">
                            <button type="button" class="egf-scm-pager-btn egf-scm-pager-prev" aria-label="Previous">‹</button>
                            <span class="egf-scm-pager-count"></span>
                            <button type="button" class="egf-scm-pager-btn egf-scm-pager-next" aria-label="Next">›</button>
                        </div>
                    </div>
                    </div>
                <?php endforeach; ?>

                <?php submit_button('Save All Sub Category Changes'); ?>
            </form>

            <div class="egf-scm-add-box">
                <h3>+ Add New Sub Category</h3>
                <form method="post" class="egf-scm-ajax-form">
                    <?php wp_nonce_field('egf_scm_add_sub', 'egf_scm_nonce'); ?>
                    <input type="hidden" name="egf_scm_action" value="add_sub">
                    <input type="hidden" name="action" value="egf_scm_add_sub_ajax">
                    <div class="egf-scm-add-grid">
                        <div class="egf-scm-field">
                            <label>Name</label>
                            <input type="text" name="new_sub_name" required>
                        </div>
                        <div class="egf-scm-field">
                            <label>Icon (Font Awesome class)</label>
                            <div class="egf-scm-icon-row">
                                <span class="egf-scm-icon-preview"><i class="fa-solid"></i></span>
                                <input type="text" class="egf-scm-icon-text" name="new_sub_icon" placeholder="fa-concierge-bell" list="egf-scm-icon-list">
                                <button type="button" class="egf-scm-icon-pick-btn">Choose</button>
                            </div>
                        </div>
                        <div class="egf-scm-field">
                            <label>Parent Category</label>
                            <select name="new_sub_parent" required>
                                <option value="">— Select —</option>
                                <?php foreach ($parent_options as $opt): ?>
                                    <option value="<?php echo esc_attr($opt->term_id); ?>"><?php echo esc_html($opt->name); ?></option>
                                <?php endforeach; ?>
                            </select>
                        </div>
                        <div class="egf-scm-field">
                            <label>Display Order</label>
                            <input type="number" class="egf-scm-order-input" name="new_sub_order" value="0" data-egf-order-scope="new-sub">
                            <span class="egf-scm-order-warning" aria-live="polite"></span>
                        </div>
                        <div class="egf-scm-field">
                            <label>Description</label>
                            <textarea name="new_sub_description"></textarea>
                        </div>
                    </div>
                    <p class="description">Only Main Categories with "Has Sub-Categories" set to Yes appear above. New sub-categories start as "Coming Soon".</p>
                    <?php submit_button('Add Sub Category', 'secondary'); ?>
                </form>
            </div>
            </div>
        </div>

        <script>
        (function () {
            var toggleNonce = '<?php echo esc_js(wp_create_nonce('egf_scm_toggle')); ?>';

            // ---------- Small helpers ----------
            function egfScmEsc(str) {
                return String(str === null || str === undefined ? '' : str)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            }

            function egfScmShowToast(message, isError) {
                var toast = document.createElement('div');
                toast.className = 'egf-scm-toast' + (isError ? ' egf-scm-toast-error' : '');
                toast.textContent = message;
                document.body.appendChild(toast);
                requestAnimationFrame(function () {
                    toast.classList.add('egf-scm-toast-show');
                });
                setTimeout(function () {
                    toast.classList.remove('egf-scm-toast-show');
                    setTimeout(function () { toast.remove(); }, 300);
                }, 2600);
            }

            // ---------- Visual icon picker (tap to see + choose the actual icon) ----------
            var EGF_SCM_ICONS = [
                ['fa-file-invoice', 'Invoice'],
                ['fa-file-invoice-dollar', 'Invoice $'],
                ['fa-mobile-screen', 'Mobile'],
                ['fa-sim-card', 'SIM Card'],
                ['fa-wallet', 'Wallet'],
                ['fa-money-bill-transfer', 'Transfer'],
                ['fa-credit-card', 'Card'],
                ['fa-receipt', 'Receipt'],
                ['fa-graduation-cap', 'Graduation'],
                ['fa-user-graduate', 'Graduate'],
                ['fa-school', 'School'],
                ['fa-book', 'Book'],
                ['fa-id-card', 'ID Card'],
                ['fa-desktop', 'Desktop'],
                ['fa-newspaper', 'Newspaper'],
                ['fa-bolt', 'Bolt'],
                ['fa-house', 'House'],
                ['fa-phone', 'Phone'],
                ['fa-tv', 'TV'],
                ['fa-wifi', 'WiFi'],
                ['fa-gas-pump', 'Fuel'],
                ['fa-plane', 'Plane'],
                ['fa-shield-halved', 'Shield'],
                ['fa-briefcase', 'Briefcase'],
                ['fa-globe', 'Globe'],
                ['fa-envelope', 'Envelope'],
                ['fa-headset', 'Support'],
                ['fa-gift', 'Gift'],
                ['fa-cart-shopping', 'Cart'],
                ['fa-chart-line', 'Chart'],
                ['fa-download', 'Download'],
                ['fa-upload', 'Upload'],
                ['fa-clipboard-question', 'Quiz'],
                ['fa-square-poll-vertical', 'Results'],
                ['fa-certificate', 'Certificate'],
                ['fa-award', 'Award'],
                ['fa-video', 'Video'],
                ['fa-circle-play', 'Play'],
                ['fa-calendar-days', 'Calendar'],
                ['fa-clock', 'Clock'],
                ['fa-bell', 'Bell'],
                ['fa-lock', 'Lock'],
                ['fa-lock-open', 'Unlocked'],
                ['fa-database', 'Database'],
                ['fa-server', 'Server'],
                ['fa-network-wired', 'Network'],
                ['fa-satellite-dish', 'Satellite'],
                ['fa-gauge-high', 'Gauge'],
                ['fa-list-check', 'Checklist'],
                ['fa-folder-open', 'Folder'],
                ['fa-print', 'Print'],
                ['fa-tags', 'Tags'],
                ['fa-comments', 'Comments'],
                ['fa-share-nodes', 'Share'],
                ['fa-magnifying-glass', 'Search'],
                ['fa-robot', 'Robot'],
                ['fa-microchip', 'Microchip'],
                ['fa-code', 'Code'],
                ['fa-terminal', 'Terminal'],
                ['fa-users', 'Users'],
                ['fa-star', 'Star'],
                ['fa-trophy', 'Trophy'],
                ['fa-medal', 'Medal'],
                ['fa-gears', 'Gears'],
                ['fa-truck-fast', 'Delivery'],
                ['fa-building-columns', 'Bank'],
                ['fa-piggy-bank', 'Savings'],
                ['fa-hand-holding-dollar', 'Payment'],
                ['fa-coins', 'Coins'],
                ['fa-percent', 'Percent'],
                ['fa-clipboard-list', 'Clipboard'],
                ['fa-pen-to-square', 'Edit'],
                ['fa-file-pdf', 'PDF'],
                ['fa-headphones-simple', 'Headphones'],
                ['fa-lightbulb', 'Idea']
            ];

            var egfScmIconModalCurrentInput = null;
            var egfScmIconModalCurrentSync = null;

            function egfScmRenderIconGrid(filter) {
                var grid = document.querySelector('#egf-scm-icon-modal .egf-scm-icon-modal-grid');
                if (!grid) return;
                var f = (filter || '').toLowerCase().trim();
                grid.innerHTML = '';
                EGF_SCM_ICONS.forEach(function (item) {
                    var cls = item[0], label = item[1];
                    if (f && cls.toLowerCase().indexOf(f) === -1 && label.toLowerCase().indexOf(f) === -1) return;
                    var btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'egf-scm-icon-option';
                    btn.innerHTML = '<i class="fa-solid ' + cls + '"></i><span>' + egfScmEsc(label) + '</span>';
                    btn.addEventListener('click', function () {
                        if (egfScmIconModalCurrentInput) {
                            egfScmIconModalCurrentInput.value = cls;
                            if (egfScmIconModalCurrentSync) egfScmIconModalCurrentSync();
                        }
                        egfScmCloseIconPicker();
                    });
                    grid.appendChild(btn);
                });
            }

            function egfScmOpenIconPicker(input, syncFn) {
                egfScmIconModalCurrentInput = input;
                egfScmIconModalCurrentSync = syncFn;
                var modal = document.getElementById('egf-scm-icon-modal');
                if (!modal) return;
                modal.classList.add('egf-scm-icon-modal-open');
                var search = modal.querySelector('.egf-scm-icon-modal-search');
                if (search) { search.value = ''; search.focus(); }
                egfScmRenderIconGrid('');
            }

            function egfScmCloseIconPicker() {
                var modal = document.getElementById('egf-scm-icon-modal');
                if (modal) modal.classList.remove('egf-scm-icon-modal-open');
                egfScmIconModalCurrentInput = null;
                egfScmIconModalCurrentSync = null;
            }

            function egfScmBindIconRow(row) {
                if (!row || row.dataset.egfIconBound) return;
                row.dataset.egfIconBound = '1';
                var input = row.querySelector('.egf-scm-icon-text');
                var preview = row.querySelector('.egf-scm-icon-preview i');
                var pickBtn = row.querySelector('.egf-scm-icon-pick-btn');
                if (!input || !preview) return;
                function syncPreview() {
                    var val = (input.value || '').trim();
                    preview.className = val ? ('fa-solid ' + val) : 'fa-solid fa-icons';
                }
                input.addEventListener('input', syncPreview);
                if (pickBtn) {
                    pickBtn.addEventListener('click', function () {
                        egfScmOpenIconPicker(input, syncPreview);
                    });
                }
                syncPreview();
            }

            // ---------- Description textareas: auto-grow, never scroll ----------
            function egfScmAutoGrow(ta) {
                ta.style.height = 'auto';
                ta.style.height = ta.scrollHeight + 'px';
            }
            function egfScmAutoGrowAttach(list) {
                list.forEach(function (ta) {
                    if (ta.dataset.egfAutogrow) return;
                    ta.dataset.egfAutogrow = '1';
                    ta.addEventListener('input', function () { egfScmAutoGrow(ta); });
                    egfScmAutoGrow(ta);
                });
            }

            // ---------- Live toggles (Status / Has Sub-Categories) ----------
            function egfScmBindToggle(toggle) {
                if (toggle.dataset.egfBound) return;
                toggle.dataset.egfBound = '1';
                toggle.addEventListener('change', function () {
                    var termId  = this.getAttribute('data-term-id');
                    var metaKey = this.getAttribute('data-meta-key');
                    var value   = this.checked ? this.getAttribute('data-on-value') : this.getAttribute('data-off-value');
                    var statusLabel = this.closest('.egf-scm-toggle-row').querySelector('.egf-scm-toggle-status');
                    var checkbox = this;

                    fetch(ajaxurl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: 'action=egf_scm_toggle&nonce=' + encodeURIComponent(toggleNonce) +
                              '&term_id=' + encodeURIComponent(termId) +
                              '&meta_key=' + encodeURIComponent(metaKey) +
                              '&value=' + encodeURIComponent(value)
                    })
                    .then(function (res) { return res.json(); })
                    .then(function (res) {
                        if (res && res.status === 'ok') {
                            if (statusLabel) {
                                if (metaKey === 'main_cat_status') statusLabel.textContent = value === 'active' ? 'Active' : 'Coming Soon';
                                if (metaKey === 'sub_cat_status') statusLabel.textContent = value === 'available' ? 'Available' : 'Coming Soon';
                                if (metaKey === 'main_cat_has_subcategories') statusLabel.textContent = value === 'yes' ? 'Yes' : 'No';
                            }
                            if (checkbox.classList.contains('egf-scm-has-subs-toggle')) {
                                var linkField = document.querySelector('.egf-scm-link-field[data-link-for="' + termId + '"]');
                                if (linkField) {
                                    linkField.classList.toggle('egf-scm-hidden', value === 'yes');
                                }
                            }
                            egfScmShowToast('Saved.');
                        } else {
                            egfScmShowToast('Could not save that change. Please try again.', true);
                            checkbox.checked = !checkbox.checked;
                        }
                    })
                    .catch(function () {
                        egfScmShowToast('Connection error. Please try again.', true);
                        checkbox.checked = !checkbox.checked;
                    });
                });
            }

            // ---------- Pagination (arrows + native swipe via scroll-snap) — one "page" = up to 3 stacked cards ----------
            // Set the grid's height to match ONLY the currently active page's content —
            // not the tallest page across the whole set (which is the root cause of the
            // gap bug: an auto-height flex row sizes to its tallest child regardless of
            // which one is scrolled into view). Skipped while hidden (e.g. inactive tab),
            // since a hidden element's scrollHeight is 0 and would wrongly zero it out.
            function egfScmSyncGridHeight(track) {
                if (track.clientWidth === 0) return; // hidden (inactive tab) — leave as-is
                var pages = track.querySelectorAll('.egf-scm-page');
                if (!pages.length) { track.style.height = ''; return; }
                var pageW = track.clientWidth || 1;
                var index = Math.round(track.scrollLeft / pageW);
                if (index > pages.length - 1) index = pages.length - 1;
                if (index < 0) index = 0;
                var activePage = pages[index];
                if (activePage) track.style.height = activePage.scrollHeight + 'px';
            }

            // (Re)attach the ResizeObserver to the grid's current .egf-scm-page children.
            // Needed after every rebuild (egfScmBuildPages removes/recreates pages), so the
            // observer keeps watching live elements instead of detached ones.
            function egfScmObservePages(track) {
                if (!track._egfScmResizeObserver) return;
                track._egfScmResizeObserver.disconnect();
                track.querySelectorAll('.egf-scm-page').forEach(function (p) {
                    track._egfScmResizeObserver.observe(p);
                });
            }

            function egfScmInitPager(track) {
                var wrap = track.closest('.egf-scm-pager-wrap');
                if (!wrap) return;

                if (!track.dataset.egfPaged) {
                    track.dataset.egfPaged = '1';
                    var prevBtn = wrap.querySelector('.egf-scm-pager-prev');
                    var nextBtn = wrap.querySelector('.egf-scm-pager-next');
                    var countEl = wrap.querySelector('.egf-scm-pager-count');

                    function update() {
                        var totalPages = track.querySelectorAll('.egf-scm-page').length;
                        var pageW = track.clientWidth || 1;
                        var index = totalPages ? Math.round(track.scrollLeft / pageW) : 0;
                        if (index > totalPages - 1) index = totalPages - 1;
                        if (index < 0) index = 0;
                        if (countEl) countEl.textContent = totalPages ? (index + 1) + ' / ' + totalPages : '0 / 0';
                        if (prevBtn) prevBtn.disabled = totalPages <= 1 || index <= 0;
                        if (nextBtn) nextBtn.disabled = totalPages <= 1 || index >= totalPages - 1;
                        egfScmSyncGridHeight(track);
                    }
                    track.addEventListener('scroll', function () {
                        clearTimeout(track._egfScmScrollTimer);
                        track._egfScmScrollTimer = setTimeout(update, 80);
                    });
                    if (prevBtn) prevBtn.addEventListener('click', function () {
                        track.scrollBy({ left: -(track.clientWidth || 1), behavior: 'smooth' });
                    });
                    if (nextBtn) nextBtn.addEventListener('click', function () {
                        track.scrollBy({ left: (track.clientWidth || 1), behavior: 'smooth' });
                    });
                    track._egfScmPagerUpdate = update;
                    if (window.ResizeObserver) {
                        track._egfScmResizeObserver = new ResizeObserver(function () { update(); });
                        egfScmObservePages(track);
                    }
                    update();
                } else if (track._egfScmPagerUpdate) {
                    track._egfScmPagerUpdate();
                }
            }

            // ---------- Group a grid's cards into pages of EGF_SCM_CARDS_PER_PAGE (rebuilds .egf-scm-page wrappers) ----------
            var EGF_SCM_CARDS_PER_PAGE = 3;

            function egfScmBuildPages(grid, cards) {
                if (!grid) return;
                // Detach old page wrappers first — the card nodes themselves are kept alive
                // via the `cards` array reference, so nothing is lost, just re-homed.
                Array.prototype.slice.call(grid.querySelectorAll('.egf-scm-page')).forEach(function (p) { p.remove(); });
                for (var i = 0; i < cards.length; i += EGF_SCM_CARDS_PER_PAGE) {
                    var page = document.createElement('div');
                    page.className = 'egf-scm-page';
                    cards.slice(i, i + EGF_SCM_CARDS_PER_PAGE).forEach(function (card) { page.appendChild(card); });
                    grid.appendChild(page);
                }
                if (grid._egfScmResizeObserver) egfScmObservePages(grid);
                egfScmSyncGridHeight(grid);
            }

            // Regroup a grid's existing cards into pages, keeping their current relative order.
            function egfScmRepaginate(grid) {
                if (!grid) return;
                var cards = Array.prototype.slice.call(grid.querySelectorAll('.egf-scm-card'));
                egfScmBuildPages(grid, cards);
            }

            // ---------- Re-sort a grid's cards by their current Display Order value (no reload) ----------
            function egfScmReorderGridByOrder(grid) {
                if (!grid) return;
                var cards = Array.prototype.slice.call(grid.querySelectorAll('.egf-scm-card'));
                cards.sort(function (a, b) {
                    var aInput = a.querySelector('.egf-scm-order-input');
                    var bInput = b.querySelector('.egf-scm-order-input');
                    var aVal = aInput ? (parseInt(aInput.value, 10) || 0) : 0;
                    var bVal = bInput ? (parseInt(bInput.value, 10) || 0) : 0;
                    return aVal - bVal;
                });
                egfScmBuildPages(grid, cards);
                grid.scrollTo({ left: 0 });
                egfScmInitPager(grid);
            }

            // ---------- Duplicate Display Order live warning ----------
            // Shows an instant message under a Display Order field if another
            // card in the same comparison scope already uses that same number.
            function egfScmOrderCardName(input) {
                var card = input.closest('.egf-scm-card');
                var h3 = card ? card.querySelector('h3') : null;
                return h3 ? h3.textContent.trim() : '';
            }

            // Which other order inputs a given input should be compared against.
            function egfScmOrderCompareGroup(input) {
                var scope = input.getAttribute('data-egf-order-scope');
                if (scope === 'new-main') {
                    var mainGrid = document.getElementById('egf-scm-main-grid');
                    return mainGrid ? Array.prototype.slice.call(mainGrid.querySelectorAll('.egf-scm-order-input')) : [];
                }
                if (scope === 'new-sub') {
                    var parentSelect = document.querySelector('select[name="new_sub_parent"]');
                    var pid = parentSelect ? parentSelect.value : '';
                    if (!pid) return [];
                    var subGrid = document.querySelector('.egf-scm-grid[data-parent-group="' + pid + '"]');
                    return subGrid ? Array.prototype.slice.call(subGrid.querySelectorAll('.egf-scm-order-input')) : [];
                }
                // An order input belonging to an existing card — compare within its own grid only.
                var grid = input.closest('.egf-scm-grid');
                return grid ? Array.prototype.slice.call(grid.querySelectorAll('.egf-scm-order-input')) : [];
            }

            function egfScmUpdateOrderWarning(input) {
                var field = input.closest('.egf-scm-field');
                var warningEl = field ? field.querySelector('.egf-scm-order-warning') : null;
                if (!warningEl) return;

                var raw = input.value.trim();
                if (raw === '') { warningEl.textContent = ''; return; }
                var num = parseInt(raw, 10);
                if (isNaN(num)) { warningEl.textContent = ''; return; }

                var group = egfScmOrderCompareGroup(input);
                var matches = [];
                group.forEach(function (other) {
                    if (other === input) return;
                    var oRaw = other.value.trim();
                    if (oRaw === '') return;
                    var oNum = parseInt(oRaw, 10);
                    if (!isNaN(oNum) && oNum === num) {
                        var name = egfScmOrderCardName(other);
                        if (name && matches.indexOf(name) === -1) matches.push(name);
                    }
                });

                warningEl.textContent = matches.length ? ('Same order as: ' + matches.join(', ')) : '';
            }

            function egfScmBindOrderWarning(input) {
                if (!input || input.dataset.egfOrderBound) return;
                input.dataset.egfOrderBound = '1';
                input.addEventListener('input', function () {
                    egfScmUpdateOrderWarning(input);
                    // If this input belongs to an existing card, refresh its grid siblings too —
                    // a change here can create or clear a conflict on the other side as well.
                    if (!input.hasAttribute('data-egf-order-scope')) {
                        egfScmOrderCompareGroup(input).forEach(function (other) {
                            if (other !== input) egfScmUpdateOrderWarning(other);
                        });
                    }
                });
                egfScmUpdateOrderWarning(input);
            }

            function egfScmBindAllOrderWarnings(scopeEl) {
                var root = scopeEl || document;
                root.querySelectorAll('.egf-scm-order-input').forEach(egfScmBindOrderWarning);
            }

            function egfScmRefreshOrderWarningsIn(scopeEl) {
                var root = scopeEl || document;
                root.querySelectorAll('.egf-scm-order-input').forEach(egfScmUpdateOrderWarning);
            }

            // ---------- Building/inserting a freshly-created card (no reload) ----------
            function egfScmBuildMainCardHtml(t) {
                var hasSubsYes = t.has_subs === 'yes';
                return '<div class="egf-scm-card" data-term-id="' + t.term_id + '">' +
                    '<h3>' + egfScmEsc(t.name) + '</h3>' +
                    '<div class="egf-scm-toggle-row"><label>Status</label><span>' +
                        '<label class="egf-scm-switch"><input type="checkbox" class="egf-scm-live-toggle" data-term-id="' + t.term_id + '" data-meta-key="main_cat_status" data-on-value="active" data-off-value="coming_soon"><span class="egf-scm-slider"></span></label>' +
                        '<span class="egf-scm-toggle-status">Coming Soon</span></span></div>' +
                    '<div class="egf-scm-toggle-row"><label>Has Sub-Categories?</label><span>' +
                        '<label class="egf-scm-switch"><input type="checkbox" class="egf-scm-live-toggle egf-scm-has-subs-toggle" data-term-id="' + t.term_id + '" data-meta-key="main_cat_has_subcategories" data-on-value="yes" data-off-value="no"' + (hasSubsYes ? ' checked' : '') + '><span class="egf-scm-slider"></span></label>' +
                        '<span class="egf-scm-toggle-status">' + (hasSubsYes ? 'Yes' : 'No') + '</span></span></div>' +
                    '<div class="egf-scm-field"><label>Icon (Font Awesome class)</label>' +
                        '<div class="egf-scm-icon-row">' +
                            '<span class="egf-scm-icon-preview"><i class="fa-solid ' + egfScmEsc(t.icon) + '"></i></span>' +
                            '<input type="text" class="egf-scm-icon-text" name="main[' + t.term_id + '][icon]" value="' + egfScmEsc(t.icon) + '" placeholder="fa-desktop" list="egf-scm-icon-list">' +
                            '<button type="button" class="egf-scm-icon-pick-btn">Choose</button>' +
                        '</div></div>' +
                    '<div class="egf-scm-field"><label>Display Order</label>' +
                        '<input type="number" class="egf-scm-order-input" name="main[' + t.term_id + '][order]" value="' + t.order + '">' +
                        '<span class="egf-scm-order-warning" aria-live="polite"></span></div>' +
                    '<div class="egf-scm-field"><label>Description</label>' +
                        '<textarea name="main[' + t.term_id + '][description]">' + egfScmEsc(t.description) + '</textarea></div>' +
                    '<div class="egf-scm-field egf-scm-link-field' + (hasSubsYes ? ' egf-scm-hidden' : '') + '" data-link-for="' + t.term_id + '">' +
                        '<label>Direct Link (only used when there are no sub-categories)</label>' +
                        '<input type="url" name="main[' + t.term_id + '][link]" value="' + egfScmEsc(t.link) + '" placeholder="https://..."></div>' +
                '</div>';
            }

            function egfScmParentOptionsHtml(selectedId) {
                var source = document.querySelector('select[name="new_sub_parent"]');
                if (!source) return '';
                var html = '';
                Array.prototype.forEach.call(source.options, function (opt) {
                    if (!opt.value) return;
                    html += '<option value="' + opt.value + '"' + (String(opt.value) === String(selectedId) ? ' selected' : '') + '>' + egfScmEsc(opt.textContent) + '</option>';
                });
                return html;
            }

            function egfScmBuildSubCardHtml(t, parentOptionsHtml) {
                return '<div class="egf-scm-card" data-term-id="' + t.term_id + '">' +
                    '<h3>' + egfScmEsc(t.name) + '</h3>' +
                    '<div class="egf-scm-toggle-row"><label>Status</label><span>' +
                        '<label class="egf-scm-switch"><input type="checkbox" class="egf-scm-live-toggle" data-term-id="' + t.term_id + '" data-meta-key="sub_cat_status" data-on-value="available" data-off-value="coming_soon"><span class="egf-scm-slider"></span></label>' +
                        '<span class="egf-scm-toggle-status">Coming Soon</span></span></div>' +
                    '<div class="egf-scm-field"><label>Icon (Font Awesome class)</label>' +
                        '<div class="egf-scm-icon-row">' +
                            '<span class="egf-scm-icon-preview"><i class="fa-solid ' + egfScmEsc(t.icon) + '"></i></span>' +
                            '<input type="text" class="egf-scm-icon-text" name="sub[' + t.term_id + '][icon]" value="' + egfScmEsc(t.icon) + '" placeholder="fa-concierge-bell" list="egf-scm-icon-list">' +
                            '<button type="button" class="egf-scm-icon-pick-btn">Choose</button>' +
                        '</div></div>' +
                    '<div class="egf-scm-field"><label>Parent Category</label>' +
                        '<select name="sub[' + t.term_id + '][parent]">' + parentOptionsHtml + '</select></div>' +
                    '<div class="egf-scm-field"><label>Display Order</label>' +
                        '<input type="number" class="egf-scm-order-input" name="sub[' + t.term_id + '][order]" value="' + t.order + '">' +
                        '<span class="egf-scm-order-warning" aria-live="polite"></span></div>' +
                    '<div class="egf-scm-field"><label>Description</label>' +
                        '<textarea name="sub[' + t.term_id + '][description]">' + egfScmEsc(t.description) + '</textarea></div>' +
                '</div>';
            }

            function egfScmInsertMainCard(term) {
                var grid = document.getElementById('egf-scm-main-grid');
                if (!grid) return;
                var holder = document.createElement('div');
                holder.innerHTML = egfScmBuildMainCardHtml(term);
                var card = holder.firstElementChild;
                grid.appendChild(card);
                card.querySelectorAll('.egf-scm-live-toggle').forEach(egfScmBindToggle);
                egfScmAutoGrowAttach(card.querySelectorAll('textarea'));
                egfScmBindIconRow(card.querySelector('.egf-scm-icon-row'));
                egfScmRepaginate(grid);
                egfScmInitPager(grid);
                egfScmBindAllOrderWarnings(grid);
                egfScmRefreshOrderWarningsIn(grid);
            }

            function egfScmInsertSubCard(term) {
                var group = document.querySelector('.egf-scm-grid[data-parent-group="' + term.parent_id + '"]');
                if (!group) {
                    // First sub-category under this parent — no group/heading exists yet on this page.
                    // Safest path is a normal reload so the new heading + grid render correctly.
                    window.location.reload();
                    return;
                }
                var holder = document.createElement('div');
                holder.innerHTML = egfScmBuildSubCardHtml(term, egfScmParentOptionsHtml(term.parent_id));
                var card = holder.firstElementChild;
                group.appendChild(card);
                card.querySelectorAll('.egf-scm-live-toggle').forEach(egfScmBindToggle);
                egfScmAutoGrowAttach(card.querySelectorAll('textarea'));
                egfScmBindIconRow(card.querySelector('.egf-scm-icon-row'));
                egfScmRepaginate(group);
                egfScmInitPager(group);
                egfScmBindAllOrderWarnings(group);
                egfScmRefreshOrderWarningsIn(group);
            }

            // ---------- "Add New Main Category": show/hide Direct Link based on Has Sub-Categories? ----------
            var addMainHasSubsSelect = document.getElementById('egf-scm-new-main-has-subs');
            var addMainLinkField = document.getElementById('egf-scm-new-main-link-field');
            function egfScmSyncMainAddLinkVisibility() {
                if (!addMainHasSubsSelect || !addMainLinkField) return;
                addMainLinkField.classList.toggle('egf-scm-hidden', addMainHasSubsSelect.value === 'yes');
            }
            if (addMainHasSubsSelect) {
                addMainHasSubsSelect.addEventListener('change', egfScmSyncMainAddLinkVisibility);
            }
            egfScmSyncMainAddLinkVisibility();

            // ---------- "Add New Sub Category": re-check order warning when parent changes ----------
            var addSubParentSelect = document.querySelector('select[name="new_sub_parent"]');
            var addSubOrderInput = document.querySelector('input[name="new_sub_order"]');
            if (addSubParentSelect && addSubOrderInput) {
                addSubParentSelect.addEventListener('change', function () {
                    egfScmUpdateOrderWarning(addSubOrderInput);
                });
            }

            // ---------- Tabs: Main Categories / Sub Categories ----------
            document.querySelectorAll('.egf-scm-tab-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    document.querySelectorAll('.egf-scm-tab-btn').forEach(function (b) { b.classList.remove('egf-scm-tab-active'); });
                    btn.classList.add('egf-scm-tab-active');
                    var target = btn.getAttribute('data-egf-tab');
                    document.querySelectorAll('.egf-scm-section').forEach(function (sec) {
                        sec.classList.toggle('egf-scm-section-active', sec.getAttribute('data-egf-section') === target);
                    });
                    document.querySelectorAll('.egf-scm-section-active .egf-scm-grid').forEach(function (grid) {
                        if (grid._egfScmPagerUpdate) grid._egfScmPagerUpdate();
                    });
                });
            });

            // ---------- Sub Category filter (custom dropdown, filters .egf-scm-subgroup by parent) ----------
            function egfScmApplySubFilter(value) {
                document.querySelectorAll('.egf-scm-subgroup').forEach(function (group) {
                    var match = (value === 'all') || (group.getAttribute('data-group-parent') === value);
                    group.classList.toggle('egf-scm-subgroup-hidden', !match);
                });
                // Newly-visible groups may have been measured while hidden (clientWidth 0) —
                // resync their pager height now that they're actually shown.
                document.querySelectorAll('.egf-scm-subgroup:not(.egf-scm-subgroup-hidden) .egf-scm-grid').forEach(function (grid) {
                    if (grid._egfScmPagerUpdate) grid._egfScmPagerUpdate();
                });
            }

            var egfScmSubFilterBtn = document.getElementById('egf-scm-subfilter-btn');
            var egfScmSubFilterPanel = document.getElementById('egf-scm-subfilter-panel');
            var egfScmSubFilterLabel = egfScmSubFilterBtn ? egfScmSubFilterBtn.querySelector('.egf-scm-subfilter-label') : null;

            function egfScmOpenSubFilter() {
                if (!egfScmSubFilterPanel) return;
                egfScmSubFilterPanel.hidden = false;
                if (egfScmSubFilterBtn) egfScmSubFilterBtn.setAttribute('aria-expanded', 'true');
            }
            function egfScmCloseSubFilter() {
                if (!egfScmSubFilterPanel) return;
                egfScmSubFilterPanel.hidden = true;
                if (egfScmSubFilterBtn) egfScmSubFilterBtn.setAttribute('aria-expanded', 'false');
            }

            if (egfScmSubFilterBtn && egfScmSubFilterPanel) {
                egfScmSubFilterBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (egfScmSubFilterPanel.hidden) egfScmOpenSubFilter(); else egfScmCloseSubFilter();
                });
                egfScmSubFilterPanel.querySelectorAll('.egf-scm-subfilter-option').forEach(function (opt) {
                    opt.addEventListener('click', function () {
                        egfScmSubFilterPanel.querySelectorAll('.egf-scm-subfilter-option').forEach(function (o) {
                            o.classList.remove('egf-scm-subfilter-option-active');
                            o.setAttribute('aria-selected', 'false');
                        });
                        opt.classList.add('egf-scm-subfilter-option-active');
                        opt.setAttribute('aria-selected', 'true');
                        if (egfScmSubFilterLabel) egfScmSubFilterLabel.textContent = opt.textContent;
                        egfScmApplySubFilter(opt.getAttribute('data-filter-value'));
                        egfScmCloseSubFilter();
                    });
                });
                document.addEventListener('click', function (e) {
                    if (!egfScmSubFilterPanel.hidden && !egfScmSubFilterBtn.contains(e.target) && !egfScmSubFilterPanel.contains(e.target)) {
                        egfScmCloseSubFilter();
                    }
                });
                document.addEventListener('keydown', function (e) {
                    if (e.key === 'Escape') egfScmCloseSubFilter();
                });
            }

            // ---------- Save All / Add New forms — submit over AJAX, no reload ----------
            document.querySelectorAll('.egf-scm-ajax-form').forEach(function (form) {
                form.addEventListener('submit', function (e) {
                    e.preventDefault();
                    var formData = new FormData(form);
                    var submitBtn = form.querySelector('[type="submit"]');
                    if (submitBtn) submitBtn.disabled = true;
                    var actionInput = form.querySelector('input[name="egf_scm_action"]');
                    var actionType = actionInput ? actionInput.value : '';

                    fetch(ajaxurl, { method: 'POST', body: formData })
                        .then(function (res) { return res.json(); })
                        .then(function (res) {
                            if (submitBtn) submitBtn.disabled = false;
                            if (res && res.status === 'ok') {
                                egfScmShowToast(res.message || 'Saved.');
                                if (actionType === 'add_main' && res.term) {
                                    egfScmInsertMainCard(res.term);
                                    form.reset();
                                    egfScmSyncMainAddLinkVisibility();
                                    egfScmRefreshOrderWarningsIn(form);
                                } else if (actionType === 'add_sub' && res.term) {
                                    egfScmInsertSubCard(res.term);
                                    form.reset();
                                    egfScmRefreshOrderWarningsIn(form);
                                } else if (actionType === 'save_main') {
                                    egfScmReorderGridByOrder(document.getElementById('egf-scm-main-grid'));
                                    egfScmRefreshOrderWarningsIn(document.getElementById('egf-scm-main-grid'));
                                } else if (actionType === 'save_sub') {
                                    document.querySelectorAll('.egf-scm-grid[data-parent-group]').forEach(egfScmReorderGridByOrder);
                                    document.querySelectorAll('.egf-scm-grid[data-parent-group]').forEach(egfScmRefreshOrderWarningsIn);
                                }
                            } else {
                                egfScmShowToast((res && res.message) || 'Could not save. Please try again.', true);
                            }
                        })
                        .catch(function () {
                            if (submitBtn) submitBtn.disabled = false;
                            egfScmShowToast('Connection error. Please try again.', true);
                        });
                });
            });

            // ---------- Initial binding ----------
            document.querySelectorAll('.egf-scm-live-toggle').forEach(egfScmBindToggle);
            document.querySelectorAll('.egf-scm-grid').forEach(function (grid) {
                egfScmRepaginate(grid);
                egfScmInitPager(grid);
            });
            egfScmAutoGrowAttach(document.querySelectorAll('.egf-scm-field textarea'));
            document.querySelectorAll('.egf-scm-icon-row').forEach(egfScmBindIconRow);
            egfScmBindAllOrderWarnings();

            // Final safety pass for the initial page load: the very first pagination
            // height sync above runs before egfScmAutoGrowAttach has finished resizing
            // description textareas to fit their content, so a page whose textarea grows
            // could get measured too early. Re-measure once more after everything on this
            // load has settled, so the first paint always reflects the final layout.
            requestAnimationFrame(function () {
                document.querySelectorAll('.egf-scm-grid').forEach(function (grid) {
                    if (grid._egfScmPagerUpdate) grid._egfScmPagerUpdate();
                });
            });

            var egfScmIconModalEl = document.getElementById('egf-scm-icon-modal');
            if (egfScmIconModalEl) {
                var egfScmIconModalSearch = egfScmIconModalEl.querySelector('.egf-scm-icon-modal-search');
                var egfScmIconModalCloseBtn = egfScmIconModalEl.querySelector('.egf-scm-icon-modal-close');
                if (egfScmIconModalSearch) {
                    egfScmIconModalSearch.addEventListener('input', function () {
                        egfScmRenderIconGrid(this.value);
                    });
                }
                if (egfScmIconModalCloseBtn) {
                    egfScmIconModalCloseBtn.addEventListener('click', egfScmCloseIconPicker);
                }
                egfScmIconModalEl.addEventListener('click', function (e) {
                    if (e.target === egfScmIconModalEl) egfScmCloseIconPicker();
                });
            }
        })();
        </script>
        <?php
    }
}
