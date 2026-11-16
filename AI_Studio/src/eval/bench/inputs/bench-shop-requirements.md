# BenchShop: product requirements

Scope: BenchShop is a small online shop. Visitors browse products; customers with an account fill a cart, apply a discount code, check
out in two steps, pay for orders, follow and cancel them, and keep a default delivery address. This document states the intended
behaviour of the web pages and of the JSON API described at `/openapi.json`. Each requirement is one numbered line; the numbers are
stable and other documents refer to them.

## 1. People and access

- 1.1 There are two kinds of people: visitors (not signed in) and customers (signed in with an account).
- 1.2 Visitors can see the product list and every product page.
- 1.3 The cart, checkout, orders and account pages need a signed-in customer; a visitor who opens one is sent to the sign-in page and returns to that page after signing in.
- 1.4 Every API operation other than the product list, a single product, registration, sign-in and sign-out answers 401 to a visitor.
- 1.5 The main navigation shows Products and Cart to everyone, Orders, Account and Sign out to customers, and Sign in and Create account to visitors.

## 2. Accounts

- 2.1 Anyone can create an account with a name, an email address and a password.
- 2.2 The name is required; an empty name is refused with the message "Enter your name."
- 2.3 The email address must be a valid email address (text, an @, and a domain with a dot); anything else is refused with the message "Enter a valid email address."
- 2.4 The password must have at least 8 characters; a shorter one is refused with a message stating the minimum.
- 2.5 An email address can belong to one account only; a second registration with the same address is refused (API: 409).
- 2.6 Email addresses are compared without regard to letter case or surrounding spaces.
- 2.7 A new account starts with no default delivery address and is signed in straight away.
- 2.8 Signing in needs the account's email address and password; a wrong combination shows "Email or password is wrong." (API: 401).
- 2.9 Signing out ends the session; the person is then a visitor.

## 3. Products

- 3.1 The product list shows every product with its name and price and states the free-shipping threshold.
- 3.2 A product page shows the name, price, description and the per-item limit, and lets a customer add the product to the cart with a quantity (default 1).
- 3.3 A visitor on a product page is invited to sign in to buy.
- 3.4 An unknown product shows "Product not found" (page and API: 404).
- 3.5 Prices are shown in dollars with two decimals; the API gives all amounts in cents.

## 4. Cart

- 4.1 Each customer has one cart; it starts empty and an empty cart says so with a link to the products.
- 4.2 Adding a product that is not in the cart creates a cart line with the chosen quantity.
- 4.3 Adding a product that is already in the cart increases that line's quantity.
- 4.4 Adding a product that does not exist is refused with "Product not found." (API: 404), and the cart is unchanged.
- 4.5 A quantity must be a whole number of at least 1; anything else is refused with a message.
- 4.6 A customer can have at most 10 of each item in the cart; a quantity above 10, whether added at once, reached by adding again, or set on the cart page, is refused with the message "You can order up to 10 of each item."
- 4.7 The cart page lets the customer change a line's quantity and remove a line.
- 4.8 Each line shows the item, the unit price, the quantity and the line total; the line total is the unit price times the quantity.
- 4.9 The subtotal is the sum of all line totals.
- 4.10 The cart shows subtotal, discount, shipping and total, and the total is subtotal minus discount plus shipping.
- 4.11 The cart page offers checkout only when the cart has at least one line.

## 5. Discounts and shipping

- 5.1 One discount code exists: SAVE10.
- 5.2 Codes are accepted regardless of letter case and surrounding spaces; an unknown code is refused with "That code is not valid." (API: 400).
- 5.3 SAVE10 takes 10% off the whole order subtotal, that is, of all cart lines together, rounded to the nearest cent.
- 5.4 An applied code stays on the cart and is shown next to the discount.
- 5.5 Shipping costs $5.00 per order.
- 5.6 Shipping is free when the subtotal after discount is $50.00 or more.
- 5.7 An empty cart has no shipping charge.

## 6. Checkout

- 6.1 Checkout has two steps in this order: 1. Delivery address, 2. Review and pay.
- 6.2 Step 1 is prefilled with the customer's default delivery address and can be changed for this checkout only.
- 6.3 A delivery address needs at least 5 characters; a shorter one is refused with "Enter a delivery address."
- 6.4 Every order needs a delivery address entered in step 1 of the current checkout; opening the review step without one sends the customer back to step 1, and placing an order without one is refused with "Add a delivery address first." (API: 409).
- 6.5 The review step shows the delivery address and the priced cart, and has a Place order button.
- 6.6 Placing an order with an empty cart is refused with "Your cart is empty." (API: 409).
- 6.7 Placing an order empties the cart and clears the checkout address, so placing again is refused because the cart is empty.
- 6.8 A placed order copies the cart's lines, subtotal, discount, shipping and total, records the delivery address and the time, and gets a number of the form ord-NNNN.
- 6.9 After placing an order the customer sees the new order's page.

## 7. Orders

- 7.1 An order is in one of four states: Placed, Paid, Shipped, Cancelled; a new order is Placed.
- 7.2 The Orders page lists all of the customer's orders, newest first, with number, date, status and total.
- 7.3 A customer with no orders sees "No orders yet."
- 7.4 An order page shows the status, the lines, the total and the delivery address.
- 7.5 A customer can see only their own orders; another person's order shows "Order not found" (page and API: 404), exactly as an order that does not exist.
- 7.6 Only a Placed order can be paid; paying moves it to Paid; any other state is refused (API: 409).
- 7.7 A customer can cancel an order until it ships; a Shipped order cannot be cancelled and the attempt is refused with a message (API: 409).
- 7.8 A Cancelled order cannot be cancelled again (API: 409).
- 7.9 The order page offers Pay now for a Placed order and Cancel order for any order that is not Cancelled; the rules above decide whether the action succeeds.
- 7.10 Shipping an order is done by the warehouse, outside this application.

## 8. Account

- 8.1 The Account page shows the email address the customer signed in with.
- 8.2 The customer can change their name and default delivery address and save them; the name is required.
- 8.3 Saved account changes are stored: after "Saved." appears, reloading the page or signing in again shows the new name and address, and the next checkout starts with the new address.
- 8.4 The email address cannot be changed.

## 9. API

- 9.1 The JSON API is described at `/openapi.json`; every operation behaves as described there, including the status codes listed.
- 9.2 Errors are JSON objects with an `error` message suitable to show to the customer.
- 9.3 Request bodies over 64 KB are ignored.
