import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { User } from '../users/user.entity';
import { Product } from '../products/product.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';
import { OrderResponseDto } from './dto/order-response.dto';

const paymentService = {
  async processPayment(orderId: number, amount: number): Promise<{ success: boolean; transactionId: string }> {
    await new Promise(resolve => setTimeout(resolve, 100));

    if (Math.random() < 0.1) {
      throw new Error('Payment service unavailable');
    }

    return { success: true, transactionId: `TXN-${Date.now()}` };
  }
};

@Injectable()
export class OrdersService {

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
    private usersService: UsersService,
    private productsService: ProductsService,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
    private dataSource: DataSource,
  ) { }

  async findAll(): Promise<Order[]> {
    return this.ordersRepository.find({
      relations: ['user', 'items', 'items.product']
    });
  }

  async findOne(id: number): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['user', 'items', 'items.product'],
    });
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }
    return order;
  }

  async findByUser(userId: number): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { userId },
      relations: ['items', 'items.product'],
    });
  }

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const { userId, items } = createOrderDto;

    // Start a transaction
    return await this.dataSource.transaction(async (transactionalEntityManager) => {

      // 1. Check User (Inside transaction)
      const user = await transactionalEntityManager.findOne(User, { where: { id: userId } });
      if (!user) throw new BadRequestException('User not found');

      // 2. Create the Order header
      const order = transactionalEntityManager.create(Order, {
        userId: user.id,
        status: OrderStatus.PENDING,
        total: 0,
      });
      const savedOrder = await transactionalEntityManager.save(order);

      let runningTotal = 0;

      // 3. Process items and stock
      for (const itemDto of items) {
        const product = await transactionalEntityManager.findOne(Product, {
          where: { id: itemDto.productId },
          lock: { mode: 'pessimistic_write' } // Prevent "Race Conditions"
        });

        if (!product || product.stock < itemDto.quantity) {
          throw new BadRequestException(`Insufficient stock for ${product?.name || 'Product'}`);
        }

        // Create OrderItem
        const orderItem = transactionalEntityManager.create(OrderItem, {
          orderId: savedOrder.id,
          productId: product.id,
          quantity: itemDto.quantity,
          price: product.price,
        });

        await transactionalEntityManager.save(orderItem);

        // Update Stock
        product.stock -= itemDto.quantity;
        await transactionalEntityManager.save(product);

        runningTotal += Number(product.price) * itemDto.quantity;
      }

      // 4. Update the final total
      savedOrder.total = runningTotal;
      return await transactionalEntityManager.save(savedOrder);
    });
    // If ANY error is thrown inside this block, the transaction automatically rolls back.
  }

  async updateStatus(id: number, status: OrderStatus): Promise<Order> {
    const order = await this.findOne(id);
    order.status = status;
    return this.ordersRepository.save(order);
  }

  async processPayment(orderId: number): Promise<{ success: boolean; transactionId: string }> {
    const order = await this.findOne(orderId);

    // Guard clause: Don't pay for already confirmed or cancelled orders
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(`Cannot process payment for order in ${order.status} state`);
    }

    const MAX_ATTEMPTS = 5;
    const BASE_DELAY = 200; // Start with 200ms

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await paymentService.processPayment(orderId, Number(order.total));

        if (result.success) {
          order.status = OrderStatus.CONFIRMED;
          await this.ordersRepository.save(order);
          return result;
        }
      } catch (error) {
        // If this was the last attempt, log and throw
        if (attempt === MAX_ATTEMPTS) {
          console.error(`Payment failed after ${MAX_ATTEMPTS} attempts: ${error.message}`);

          // Optional: Update status to a custom "PAYMENT_FAILED" or keep PENDING
          throw new BadRequestException('Payment service is currently unavailable. Please try again later.');
        }

        // Exponential Backoff calculation: delay = base * 2^(attempt-1)
        // Attempt 1: 200ms | Attempt 2: 400ms | Attempt 3: 800ms | Attempt 4: 1600ms
        const backoffDelay = BASE_DELAY * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 100; // Add up to 100ms of randomness

        // Wait before retrying to avoid overwhelming the payment service
        await new Promise(resolve => setTimeout(resolve, backoffDelay + jitter));
      }
    }

    throw new BadRequestException('Payment processing failed.');
  }

  async cancel(id: number): Promise<Order> {
    const order = await this.findOne(id);

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Only pending orders can be cancelled');
    }

    for (const item of order.items) {
      const product = await this.productsService.findOne(item.productId);
      await this.productsService.updateStock(product.id, product.stock + item.quantity);
    }

    order.status = OrderStatus.CANCELLED;
    return this.ordersRepository.save(order);
  }

  // 3. The third problem is that in the getOrderWithFullDetails method there is a circular reference between the order and user entities. The spread operator {...order}. which can lead to infinite recursion when trying to serialize the data. To fix this, we should avoid including the user details in the order response or use a DTO to control the serialization process.
  // Solution: To fix the circular reference issue, we can create a DTO (Data Transfer Object) that only includes the necessary fields for the order response, excluding the user details. This way, we can avoid the infinite recursion when serializing the data. Additionally, we can use TypeORM's eager loading to fetch all the necessary data in a single query, which will improve performance.
  async getOrderWithFullDetails(id: number): Promise<OrderResponseDto> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['user', 'items', 'items.product', 'items.product.category'],
    });

    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }

    return {
      id: order.id,
      status: order.status,
      total: Number(order.total),
      createdAt: order.createdAt,
      user: {
        id: order.user.id,
        name: order.user.name,
        email: order.user.email,
      },
      items: order.items.map(item => ({
        productId: item.productId,
        productName: item.product.name,
        quantity: item.quantity,
        price: Number(item.price),
        category: item.product.category?.name || 'Uncategorized',
      })),
    };
  }
}
