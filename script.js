/* =========================================================
   Bokka Bageri — script.js
   Vanilla JS only. Handles:
   - interest form validation
   - asynchronous submission to the Bokka Intake endpoint (no page reload)
   - a warm success message
   - gentle scroll-reveal animations
   ========================================================= */

(function () {
  "use strict";

  // "Bokka Intake" Apps Script web app /exec URL — receives BOTH forms (form_type decides).
  // Leave "" to fall back to each form's action attribute (Formspree) — the rollback switch.
  const INTAKE_ENDPOINT = "https://script.google.com/macros/s/AKfycbwY5Z4-fyE2dP9xTBy9VIsn6e_9DRwXBPRKGn6jIkb8q7I6UQwtldSZMZehsJtCgsmw/exec";

  /**
   * POST a form. Apps Script cannot answer CORS preflight, so the direct request must
   * stay "simple": urlencoded body, no custom headers. Resolves true only on {ok:true}
   * (direct) or HTTP 2xx (Formspree fallback).
   */
  function postForm(formEl) {
    const direct = INTAKE_ENDPOINT.length > 0;
    const url = direct ? INTAKE_ENDPOINT : formEl.action;
    const options = direct
      ? { method: "POST", body: new URLSearchParams(new FormData(formEl)) }
      : { method: "POST", body: new FormData(formEl), headers: { Accept: "application/json" } };

    return fetch(url, options)
      .then(function (response) {
        if (!response.ok) throw new Error("http " + response.status);
        return direct ? response.json() : { ok: true };
      })
      .then(function (data) {
        return Boolean(data && data.ok);
      });
  }

  /* -----------------------------------------------------
     Interest form
     ----------------------------------------------------- */
  const form = document.getElementById("interest-form");
  const successBox = document.getElementById("form-success");
  const successText = document.getElementById("form-success-text");
  const resetBtn = document.getElementById("form-reset");
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
  const formError = document.getElementById("form-error");
  const submitBtnLabel = submitBtn ? submitBtn.textContent : "";

  /**
   * Basic email check for the required / optional e-post fields.
   */
  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  }

  function setError(input, errorEl, show) {
    if (show) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorEl.id);
      errorEl.hidden = false;
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
      errorEl.hidden = true;
    }
  }

  if (form) {
    const firstName = form.elements["fornavn"];
    const email = form.elements["epost"];
    const firstNameError = document.getElementById("fornavn-error");
    const emailError = document.getElementById("epost-error");

    // Clear an error as soon as the neighbour starts fixing it.
    firstName.addEventListener("input", function () {
      if (firstName.value.trim()) setError(firstName, firstNameError, false);
    });
    email.addEventListener("input", function () {
      if (isValidEmail(email.value)) setError(email, emailError, false);
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      const nameOk = firstName.value.trim().length > 0;
      const emailOk = isValidEmail(email.value);

      setError(firstName, firstNameError, !nameOk);
      setError(email, emailError, !emailOk);

      if (!nameOk) {
        firstName.focus();
        return;
      }
      if (!emailOk) {
        email.focus();
        return;
      }

      submitInterest();
    });

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        form.reset();
        hideFormError();
        setSubmitting(false);
        successBox.hidden = true;
        form.hidden = false;
        firstName.focus();
      });
    }
  }

  /**
   * Send the interest form without a page reload. The success state is shown only
   * after the server confirms; a network error or rejection shows a friendly notice.
   */
  function submitInterest() {
    if (!form) return;
    hideFormError();
    setSubmitting(true);

    const name = form.elements["fornavn"].value.trim();

    postForm(form)
      .then(function (ok) {
        if (ok) {
          showSuccess(name);
        } else {
          showFormError();
        }
      })
      .catch(function () {
        showFormError();
      })
      .then(function () {
        setSubmitting(false);
      });
  }

  function setSubmitting(isSubmitting) {
    if (!submitBtn) return;
    submitBtn.disabled = isSubmitting;
    if (isSubmitting) {
      form.setAttribute("aria-busy", "true");
      submitBtn.textContent = "Sender …";
    } else {
      form.removeAttribute("aria-busy");
      submitBtn.textContent = submitBtnLabel;
    }
  }

  function showFormError() {
    if (formError) formError.hidden = false;
  }

  function hideFormError() {
    if (formError) formError.hidden = true;
  }

  function showSuccess(name) {
    if (!successBox) return;
    if (successText) {
      successText.textContent =
        "Takk, " +
        name +
        "! Vi sier fra neste gang Bokka fyrer opp ovnen. Helt uforpliktende, som lovet.";
    }
    form.hidden = true;
    successBox.hidden = false;
    // Move focus so screen readers announce the result.
    successBox.setAttribute("tabindex", "-1");
    successBox.focus();
    successBox.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* -----------------------------------------------------
     Weekend order form ("Denne helgen baker vi")
     Separate from the interest form: its own submission,
     quantity steppers, success and error states.
     ----------------------------------------------------- */
  (function initOrderForm() {
    const orderForm = document.getElementById("order-form");
    if (!orderForm) return;

    const orderSuccess = document.getElementById("order-success");
    const orderSuccessText = document.getElementById("order-success-text");
    const orderError = document.getElementById("order-error");
    const orderEmpty = document.getElementById("order-empty");
    const orderReset = document.getElementById("order-reset");
    const orderSubmit = orderForm.querySelector('button[type="submit"]');
    const orderSubmitLabel = orderSubmit ? orderSubmit.textContent : "";
    const summaryField = orderForm.elements["bestilling"];

    const firstName = orderForm.elements["fornavn"];
    const mobile = orderForm.elements["mobil"];
    const email = orderForm.elements["epost"];
    const address = orderForm.elements["adresse"];
    const firstNameError = document.getElementById("order-fornavn-error");
    const mobileError = document.getElementById("order-mobil-error");
    const emailError = document.getElementById("order-epost-error");
    const addressError = document.getElementById("order-adresse-error");

    const qtyInputs = Array.prototype.slice.call(
      orderForm.querySelectorAll(".qty__input")
    );

    function clampQty(value) {
      const n = parseInt(value, 10);
      if (isNaN(n)) return 0;
      return Math.max(0, Math.min(10, n));
    }

    function hasItems() {
      return qtyInputs.some(function (input) {
        return clampQty(input.value) > 0;
      });
    }

    function isValidPhone(value) {
      return (value.match(/\d/g) || []).length >= 8;
    }

    // Wire up the +/- steppers, keeping every value inside 0–10.
    Array.prototype.forEach.call(
      orderForm.querySelectorAll("[data-qty]"),
      function (wrap) {
        const input = wrap.querySelector(".qty__input");
        const dec = wrap.querySelector("[data-qty-dec]");
        const inc = wrap.querySelector("[data-qty-inc]");
        if (!input) return;

        function set(next) {
          input.value = clampQty(next);
          if (orderEmpty && hasItems()) orderEmpty.hidden = true;
        }
        if (dec) dec.addEventListener("click", function () { set(clampQty(input.value) - 1); });
        if (inc) inc.addEventListener("click", function () { set(clampQty(input.value) + 1); });
        input.addEventListener("change", function () { set(input.value); });
      }
    );

    // Clear field errors as the visitor fixes them.
    firstName.addEventListener("input", function () {
      if (firstName.value.trim()) setError(firstName, firstNameError, false);
    });
    mobile.addEventListener("input", function () {
      if (isValidPhone(mobile.value)) setError(mobile, mobileError, false);
    });
    email.addEventListener("input", function () {
      if (email.value.trim() === "" || isValidEmail(email.value)) setError(email, emailError, false);
    });
    address.addEventListener("input", function () {
      if (address.value.trim()) setError(address, addressError, false);
    });

    orderForm.addEventListener("submit", function (event) {
      event.preventDefault();

      const nameOk = firstName.value.trim().length > 0;
      const phoneOk = isValidPhone(mobile.value);
      const emailVal = email.value.trim();
      const emailOk = emailVal === "" || isValidEmail(emailVal);
      const addressOk = address.value.trim().length > 0;
      const itemsOk = hasItems();

      setError(firstName, firstNameError, !nameOk);
      setError(mobile, mobileError, !phoneOk);
      setError(email, emailError, !emailOk);
      setError(address, addressError, !addressOk);
      if (orderEmpty) orderEmpty.hidden = itemsOk;

      if (!itemsOk) {
        if (orderEmpty) orderEmpty.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (!nameOk) { firstName.focus(); return; }
      if (!phoneOk) { mobile.focus(); return; }
      if (!emailOk) { email.focus(); return; }
      if (!addressOk) { address.focus(); return; }

      submitOrder();
    });

    if (orderReset) {
      orderReset.addEventListener("click", function () {
        orderForm.reset();
        qtyInputs.forEach(function (input) { input.value = 0; });
        if (orderError) orderError.hidden = true;
        if (orderEmpty) orderEmpty.hidden = true;
        setOrderSubmitting(false);
        if (orderSuccess) orderSuccess.hidden = true;
        orderForm.hidden = false;
        firstName.focus();
      });
    }

    // Build a readable "Klassisk surdeigsbrød × 1, Kanelbolle × 4" line for the email.
    function buildSummary() {
      return qtyInputs
        .map(function (input) {
          const n = clampQty(input.value);
          if (n <= 0) return null;
          const name = input.getAttribute("data-product") || input.name;
          return name + " \u00d7 " + n;
        })
        .filter(Boolean)
        .join(", ");
    }

    function submitOrder() {
      if (orderError) orderError.hidden = true;
      if (summaryField) summaryField.value = buildSummary();
      setOrderSubmitting(true);

      const name = firstName.value.trim();

      postForm(orderForm)
        .then(function (ok) {
          if (ok) {
            showOrderSuccess(name);
          } else if (orderError) {
            orderError.hidden = false;
          }
        })
        .catch(function () {
          if (orderError) orderError.hidden = false;
        })
        .then(function () {
          setOrderSubmitting(false);
        });
    }

    function setOrderSubmitting(isSubmitting) {
      if (!orderSubmit) return;
      orderSubmit.disabled = isSubmitting;
      if (isSubmitting) {
        orderForm.setAttribute("aria-busy", "true");
        orderSubmit.textContent = "Sender \u2026";
      } else {
        orderForm.removeAttribute("aria-busy");
        orderSubmit.textContent = orderSubmitLabel;
      }
    }

    function showOrderSuccess(name) {
      if (!orderSuccess) return;
      if (orderSuccessText) {
        orderSuccessText.textContent =
          "Takk for bestillingen, " + name +
          "! Vi har notert ønsket ditt for helgen. Bokka gir deg beskjed så snart vi kan – bestillingen er først bekreftet når du får svar fra oss. 🌾";
      }
      orderForm.hidden = true;
      orderSuccess.hidden = false;
      orderSuccess.setAttribute("tabindex", "-1");
      orderSuccess.focus();
      orderSuccess.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  })();

  /* -----------------------------------------------------
     Delivery day → time groups
     Reveals a day's time options only when the day is checked, and clears that
     day's selected times when hidden so they are never submitted.
     ----------------------------------------------------- */
  (function initDeliveryDays() {
    const toggles = document.querySelectorAll("[data-day-toggle]");
    if (!toggles.length) return;

    const bothHint = document.getElementById("day-both-hint");

    function sync(toggle) {
      const group = document.getElementById(
        toggle.getAttribute("aria-controls")
      );
      if (!group) return;
      const open = toggle.checked;
      group.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open) {
        group
          .querySelectorAll('input[type="checkbox"]')
          .forEach(function (box) {
            box.checked = false;
          });
      }
    }

    function updateBothHint() {
      if (!bothHint) return;
      const both = Array.prototype.every.call(toggles, function (t) {
        return t.checked;
      });
      bothHint.hidden = !both;
    }

    toggles.forEach(function (toggle) {
      sync(toggle);
      toggle.addEventListener("change", function () {
        sync(toggle);
        updateBothHint();
      });
    });

    updateBothHint();
  })();

  /* -----------------------------------------------------
     Gentle scroll-reveal animations
     Respects prefers-reduced-motion via CSS.
     ----------------------------------------------------- */
  const revealTargets = document.querySelectorAll(
    ".product-card, .order-card, .step, .bobler-card, .bobler__art, .story__inner, .section__head, .interest__card"
  );

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if ("IntersectionObserver" in window && !prefersReducedMotion) {
    revealTargets.forEach(function (el) {
      el.classList.add("reveal");
    });

    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );

    revealTargets.forEach(function (el) {
      observer.observe(el);
    });
  }
})();
